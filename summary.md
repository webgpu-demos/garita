# Synthetic data experiment

7 runs. Scores on the REAL test frames only (weights picked on real val). ± = standard deviation over seeds.

Classes: building, blue_tarp, debris, vehicle. Real frames train/val/test: 4/2/1 (2/1/1 flights). Synthetic frames available: 7.

## map50_95

| real share | real only | + 1 synthetic per real | synthetic only |
|---|---|---|---|
| 0 |  |  | 0.064 |
| 0.5 | 0.101 | 0.096 |  |
| 1 | 0.105 | 0.080 |  |

## map50

| real share | real only | + 1 synthetic per real | synthetic only |
|---|---|---|---|
| 0 |  |  | 0.193 |
| 0.5 | 0.197 | 0.154 |  |
| 1 | 0.216 | 0.152 |  |

## gain in map50_95 over real only (paired by seed)

| real share | + 1 synthetic per real |
|---|---|
| 0.5 | -0.005 |
| 1 | -0.025 |

## pretrained on synthetic only, then fine-tuned on the real share (map50_95)

| real share | real only | fine-tuned | gain (paired by seed) |
|---|---|---|---|
| 0.5 | 0.101 | 0.072 | -0.029 |
| 1 | 0.105 | 0.031 | -0.074 |

## map50_95 per class

| real share | training | building | blue_tarp | debris | vehicle |
|---|---|---|---|---|---|
| 0 | synthetic only | 0.164 | 0.000 | 0.064 | 0.029 |
| 0.5 | real only | 0.267 | 0.000 | 0.101 | 0.037 |
| 0.5 | + 1 synthetic per real | 0.277 | 0.000 | 0.096 | 0.011 |
| 1 | real only | 0.275 | 0.000 | 0.105 | 0.040 |
| 1 | + 1 synthetic per real | 0.203 | 0.000 | 0.080 | 0.036 |
| 0.5 | fine-tuned | 0.208 | 0.000 | 0.072 | 0.009 |
| 1 | fine-tuned | 0.053 | 0.000 | 0.031 | 0.040 |

Instances in the real test frames: building 7, blue_tarp 1, debris 0, vehicle 21. A class with none there gets the mean of the others (Ultralytics), so its column says nothing.
