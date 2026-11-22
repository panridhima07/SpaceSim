import requests
import json

url = "https://ssd.jpl.nasa.gov/api/horizons.api"

params = {
    "format": "json",
    "COMMAND": "'-158'",
    "OBJ_DATA": "YES",
    "MAKE_EPHEM": "YES",
    "EPHEM_TYPE": "VECTORS",

    # Sun-centred coordinates initially
    "CENTER": "'500@0'",

    "VEC_TABLE": "2",
    "CSV_FORMAT": "YES",

    # Chandrayaan-3 mission period
    "START_TIME": "'2023-07-14 10:00'",
    "STOP_TIME": "'2023-09-06'",
    "STEP_SIZE": "'1 h'"
}

response = requests.get(url, params=params, timeout=120)

print("Status:", response.status_code)

response.raise_for_status()

data = response.json()

if "error" in data:
    print("JPL Error:", data["error"])

else:
    with open("chandrayaan3_trajectory.json", "w") as file:
        json.dump(data, file, indent=4)

    print("Chandrayaan-3 trajectory downloaded!")