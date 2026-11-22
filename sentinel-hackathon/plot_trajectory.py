import json
import matplotlib.pyplot as plt

with open("chandrayaan3_clean.json", "r") as file:
    records = json.load(file)

x = [r["position_km"]["x"] for r in records]
y = [r["position_km"]["y"] for r in records]

plt.figure(figsize=(10, 7))

plt.plot(x, y, label="Chandrayaan-3 trajectory")
plt.scatter(x[0], y[0], label="Start")
plt.scatter(x[-1], y[-1], label="End")

plt.xlabel("X position (km)")
plt.ylabel("Y position (km)")
plt.title("Chandrayaan-3 trajectory from JPL Horizons")

plt.legend()
plt.grid()
plt.axis("equal")
plt.show()