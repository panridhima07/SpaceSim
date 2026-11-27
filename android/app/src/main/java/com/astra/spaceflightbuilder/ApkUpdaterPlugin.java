package com.astra.spaceflightbuilder;

import android.content.Context;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;

import androidx.core.content.FileProvider;
import androidx.core.content.pm.PackageInfoCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Updates a sideloaded app from an APK: downloads it into the app's cache, checks that it is
 * this app and newer than the installed one, then hands it to Android's installer. Android asks
 * the person to confirm, and refuses an APK signed with a different key.
 *
 * JS: ApkUpdater.info() and ApkUpdater.downloadAndInstall({ url, version }); progress arrives as
 * "apkProgress" events ({ received, total }; total is 0 when the server does not say).
 * See src/app/apkUpdater.ts and src/app/appUpdate.ts.
 */
@CapacitorPlugin(name = "ApkUpdater")
public class ApkUpdaterPlugin extends Plugin {

    private static final String DIR = "apk-update";
    /** An APK larger than this is not ours (the app is about 15 MB). */
    private static final long MAX_BYTES = 200L * 1024 * 1024;
    private static final int MAX_REDIRECTS = 5;
    /** Same prefix as DEFAULT_DOWNLOAD_PREFIX in src/app/appUpdate.ts. */
    private static final String RELEASES_PREFIX = "https://github.com/panridhima07/SpaceSim/releases/";
    private static final int TIMEOUT_MS = 20000;

    private final AtomicBoolean busy = new AtomicBoolean(false);

    private boolean isDebuggable() {
        return (getContext().getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
    }

    /** True in builds made for Google Play (build type "play" sets this manifest flag). */
    private boolean isPlayBuild() {
        try {
            Context ctx = getContext();
            ApplicationInfo ai = ctx.getPackageManager().getApplicationInfo(ctx.getPackageName(), PackageManager.GET_META_DATA);
            Bundle meta = ai.metaData;
            return meta != null && meta.getBoolean("astra.playBuild", false);
        } catch (Exception e) {
            return false;
        }
    }

    private PackageInfo installed() throws PackageManager.NameNotFoundException {
        Context ctx = getContext();
        return ctx.getPackageManager().getPackageInfo(ctx.getPackageName(), 0);
    }

    @PluginMethod
    public void info(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("debug", isDebuggable());
        ret.put("play", isPlayBuild());
        try {
            PackageInfo pi = installed();
            ret.put("versionCode", PackageInfoCompat.getLongVersionCode(pi));
            ret.put("versionName", pi.versionName == null ? "" : pi.versionName);
        } catch (Exception e) {
            ret.put("versionCode", 0);
            ret.put("versionName", "");
        }
        call.resolve(ret);
    }

    @PluginMethod
    public void downloadAndInstall(PluginCall call) {
        final String url = call.getString("url");
        final String version = call.getString("version", "");
        if (url == null || version == null || !version.matches("[0-9A-Za-z.+-]{1,24}")) {
            call.reject("url and version are required");
            return;
        }
        if (isPlayBuild()) {
            call.reject("Google Play updates this app");
            return;
        }
        // The page checks this too (src/app/appUpdate.ts), but web code is not the trust
        // boundary: release builds only start downloads from the project's GitHub releases.
        // Debug builds may use a test server (VITE_APP_UPDATE_DOWNLOAD_PREFIX).
        if (!isDebuggable() && !url.startsWith(RELEASES_PREFIX)) {
            call.reject("Updates only come from the project's GitHub releases");
            return;
        }
        if (!busy.compareAndSet(false, true)) {
            call.reject("An update is already downloading");
            return;
        }
        new Thread(() -> {
            try {
                File apk = new File(new File(getContext().getCacheDir(), DIR), "astra-" + version + ".apk");
                // A finished download of this version is reused, for example after the app was
                // restarted while the person allowed installs in Settings.
                if (!isUsable(apk)) {
                    download(url, apk);
                    if (!isUsable(apk)) {
                        //noinspection ResultOfMethodCallIgnored
                        apk.delete();
                        call.reject("The downloaded file is not a newer version of this app");
                        return;
                    }
                }
                JSObject ret = new JSObject();
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !getContext().getPackageManager().canRequestPackageInstalls()) {
                    Intent settings = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + getContext().getPackageName()));
                    settings.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    getContext().startActivity(settings);
                    ret.put("status", "permission");
                    call.resolve(ret);
                    return;
                }
                Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", apk);
                Intent install = new Intent(Intent.ACTION_VIEW);
                install.setDataAndType(uri, "application/vnd.android.package-archive");
                install.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(install);
                ret.put("status", "installer");
                call.resolve(ret);
            } catch (Exception e) {
                call.reject("Could not update: " + e.getMessage(), e);
            } finally {
                busy.set(false);
            }
        }, "apk-update").start();
    }

    /** The file is an APK of this app with a higher version code than the installed one. */
    private boolean isUsable(File apk) {
        try {
            if (!apk.isFile() || apk.length() == 0) return false;
            PackageInfo archive = getContext().getPackageManager().getPackageArchiveInfo(apk.getAbsolutePath(), 0);
            if (archive == null || !getContext().getPackageName().equals(archive.packageName)) return false;
            return PackageInfoCompat.getLongVersionCode(archive) > PackageInfoCompat.getLongVersionCode(installed());
        } catch (Exception e) {
            return false;
        }
    }

    /**
     * Downloads to a temporary file and renames it when complete. Redirects are followed by hand
     * so that every hop is checked: HTTPS only (plain HTTP is accepted in debug builds, for
     * testing against a local server). GitHub serves release files from a second host, so the
     * host itself is not checked; the package and signature checks protect the install.
     */
    private void download(String start, File dest) throws Exception {
        File dir = dest.getParentFile();
        if (dir == null) throw new java.io.IOException("No cache folder");
        // Older downloads are no longer needed.
        File[] old = dir.listFiles();
        if (old != null) {
            for (File f : old) {
                //noinspection ResultOfMethodCallIgnored
                f.delete();
            }
        }
        if (!dir.isDirectory() && !dir.mkdirs()) throw new java.io.IOException("Could not create the cache folder");

        String next = start;
        HttpURLConnection conn = null;
        try {
            for (int hop = 0; ; hop++) {
                URL u = new URL(next);
                boolean https = "https".equalsIgnoreCase(u.getProtocol());
                if (!https && !("http".equalsIgnoreCase(u.getProtocol()) && isDebuggable())) {
                    throw new java.io.IOException("Only HTTPS downloads are allowed");
                }
                conn = (HttpURLConnection) u.openConnection();
                conn.setInstanceFollowRedirects(false);
                conn.setConnectTimeout(TIMEOUT_MS);
                conn.setReadTimeout(TIMEOUT_MS);
                conn.setRequestProperty("Accept", "application/octet-stream");
                int code = conn.getResponseCode();
                if (code >= 300 && code < 400) {
                    String location = conn.getHeaderField("Location");
                    conn.disconnect();
                    conn = null;
                    if (location == null || hop >= MAX_REDIRECTS) throw new java.io.IOException("Too many redirects");
                    next = new URL(u, location).toString();
                    continue;
                }
                if (code != 200) throw new java.io.IOException("Server answered " + code);
                break;
            }
            long total = conn.getContentLengthLong();
            if (total > MAX_BYTES) throw new java.io.IOException("File is too large");
            File part = new File(dir, dest.getName() + ".part");
            long received = 0;
            long lastNotified = 0;
            try (InputStream in = conn.getInputStream(); OutputStream out = new FileOutputStream(part)) {
                byte[] buf = new byte[64 * 1024];
                int n;
                while ((n = in.read(buf)) != -1) {
                    out.write(buf, 0, n);
                    received += n;
                    if (received > MAX_BYTES) throw new java.io.IOException("File is too large");
                    if (received - lastNotified >= 256 * 1024) {
                        lastNotified = received;
                        notifyProgress(received, total);
                    }
                }
            }
            if (total > 0 && received != total) throw new java.io.IOException("Download was cut short");
            notifyProgress(received, total);
            if (!part.renameTo(dest)) throw new java.io.IOException("Could not save the download");
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    private void notifyProgress(long received, long total) {
        JSObject p = new JSObject();
        p.put("received", received);
        p.put("total", Math.max(total, 0));
        notifyListeners("apkProgress", p);
    }
}
