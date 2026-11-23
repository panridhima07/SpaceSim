// Shared shapes for everything that leaves the browser: cloud-saved designs, uploaded
// files, remembered import corrections, server-side simulation and the consent that
// gates data collection.

import type { Design } from '../builder/design';
import type { RocketModel } from '../types';

/** Bump when the consent wording changes; people are asked again. */
export const CONSENT_VERSION = 1;

export interface ConsentState {
  /** May their uploaded files, corrections and flight results be used to improve the importer. */
  research: boolean;
  version: number;
  /** Epoch ms of the decision. */
  decidedAt: number;
}

/** The signed-in person, as the cloud layer needs them. Guests have none. */
export interface CloudSession {
  userId: string;
  accessToken: string;
}

/** One difference between what the importer produced and what the user says is right. */
export interface CorrectionChange {
  kind: 'added' | 'removed' | 'changed' | 'moved';
  partName: string;
  /** Component kind: 'nosecone', 'bodytube', 'finset', … */
  partKind: string;
  /** Field names that differ, for 'changed'. */
  fields?: string[];
}

/** A user's fix for how one file was imported, keyed by the file's SHA-256. */
export interface ImportCorrection {
  fileSha256: string;
  filename: string;
  /** What our importer made of the file, before any edit. */
  parsedModel: RocketModel;
  /** The design as the user corrected it. */
  correctedDesign: Design;
  /** Optional words from the user on what was wrong. */
  note: string;
  changes: CorrectionChange[];
  /** Epoch ms. */
  updatedAt: number;
}

export interface CloudDesign {
  id: string;
  name: string;
  design: Design;
  thumbnail?: string;
  /** SHA-256 of the file it was imported from, if any. */
  sourceFileSha256?: string;
  /** Epoch ms. */
  updatedAt: number;
}
