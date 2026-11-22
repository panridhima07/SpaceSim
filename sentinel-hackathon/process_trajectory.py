import json
import csv
import io

with open("chandrayaan3_trajectory.json", "r") as file:
    data = json.load(file)

result = data["result"]

start = result.find("$$SOE") + len("$$SOE")
end = result.find("$$EOE")

if start < len("$$SOE") or end == -1:
    raise ValueError("Trajectory data markers not found")

csv_data = result[start:end].strip()

reader = csv.reader(io.StringIO(csv_data))

records = []

for row in reader:
    if len(row) < 8:
        continue

    try:
        records.append({
            "julian_date": float(row[0]),
            "date": row[1].strip(),
            "position_km": {
                "x": float(row[2]),
                "y": float(row[3]),
                "z": float(row[4])
            },
            "velocity_km_s": {
                "vx": float(row[5]),
                "vy": float(row[6]),
                "vz": float(row[7])
            }
        })

    except ValueError:
        continue

with open("chandrayaan3_clean.json", "w") as file:
    json.dump(records, file, indent=4)

print("Total records:", len(records))
print("First record:", records[0] if records else "No records found")