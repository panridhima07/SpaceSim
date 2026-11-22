import requests
import json

url = "https://ssd.jpl.nasa.gov/api/horizons.api"

# Object names and their JPL IDs
bodies = {
    "earth": "399",
    "moon": "301",
    "mars": "499",
    "sun": "10"
}

for name, body_id in bodies.items():

    params = {
        "format": "json",
        "COMMAND": f"'{body_id}'",
        "OBJ_DATA": "NO",
        "MAKE_EPHEM": "YES",
        "EPHEM_TYPE": "VECTORS",
        "CENTER": "'500@0'",
        "VEC_TABLE": "2",
        "START_TIME": "'2026-11-21'",
        "STOP_TIME": "'2026-11-25'",
        "STEP_SIZE": "'1 d'"
    }

    try:
        response = requests.get(url, params=params, timeout=30)
        response.raise_for_status()

        data = response.json()

        # Check for an API error
        if "error" in data:
            print(f"{name}: API error - {data['error']}")
            continue

        # Save the API response
        filename = f"{name}_data.json"

        with open(filename, "w") as file:
            json.dump(data, file, indent=4)

        print(f"{filename} created successfully!")

    except Exception as e:
        print(f"Failed to download {name}: {e}")