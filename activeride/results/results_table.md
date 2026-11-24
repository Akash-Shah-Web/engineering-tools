# ActiveRide results (SIMULATION ONLY — MuJoCo plant, no real-vehicle tests)

Road inputs: MEASURED = LiRA-CD P79 profilometer wheel paths (DOI 10.11583/DTU.23097002);
SYNTHETIC = analytic obstacle shapes. Percentages are changes relative to passive.

## Motorway M13, section A (km 16.55-17.15) — MEASURED, 90 km/h

| Metric | Passive | Skyhook | LQR + Kalman | Preview LQR |
|---|---|---|---|---|
| Seat a_w (Wk) [m/s²] | 0.148 | 0.14 (-5%) | 0.0934 (-37%) | 0.0788 (-47%) |
| Seat VDV (Wk) [m/s^1.75] | 0.614 | 0.608 (-1%) | 0.381 (-38%) | 0.272 (-56%) |
| Pitch acc. (We) RMS [rad/s²] | 0.0492 | 0.0303 (-39%) | 0.0302 (-39%) | 0.0207 (-58%) |
| Roll acc. (We) RMS [rad/s²] | 0.0815 | 0.0398 (-51%) | 0.0345 (-58%) | 0.0312 (-62%) |
| Pitch RMS [deg] | 0.0605 | 0.042 (-31%) | 0.0423 (-30%) | 0.0401 (-34%) |
| Roll RMS [deg] | 0.284 | 0.272 (-4%) | 0.262 (-8%) | 0.271 (-4%) |
| Susp. travel RMS [mm] | 2.31 | 2.65 (+15%) | 2.66 (+15%) | 1.28 (-44%) |
| Susp. travel max [mm] | 15.9 | 10.8 (-32%) | 12.4 (-22%) | 11 (-31%) |
| Tyre DLC (worst corner) [-] | 0.039 | 0.0364 (-7%) | 0.0367 (-6%) | 0.0339 (-13%) |
| Min tyre load / static [-] | 0.646 | 0.683 (+6%) | 0.699 (+8%) | 0.756 (+17%) |
| Actuator power (no regen) [W] | 0 | 1.23 | 7.34 | 12.1 |
| Peak actuator force [N] | 0 | 273 | 516 | 953 |

## Motorway M13, section C (km 18.55-19.06) — MEASURED, 90 km/h

| Metric | Passive | Skyhook | LQR + Kalman | Preview LQR |
|---|---|---|---|---|
| Seat a_w (Wk) [m/s²] | 0.117 | 0.0897 (-23%) | 0.0707 (-40%) | 0.0654 (-44%) |
| Seat VDV (Wk) [m/s^1.75] | 0.38 | 0.333 (-12%) | 0.248 (-35%) | 0.195 (-49%) |
| Pitch acc. (We) RMS [rad/s²] | 0.046 | 0.0255 (-45%) | 0.0278 (-40%) | 0.0205 (-55%) |
| Roll acc. (We) RMS [rad/s²] | 0.0696 | 0.0354 (-49%) | 0.0326 (-53%) | 0.031 (-55%) |
| Pitch RMS [deg] | 0.0602 | 0.0409 (-32%) | 0.0414 (-31%) | 0.0394 (-35%) |
| Roll RMS [deg] | 0.291 | 0.282 (-3%) | 0.275 (-5%) | 0.279 (-4%) |
| Susp. travel RMS [mm] | 2.27 | 2.6 (+15%) | 2.62 (+16%) | 1.14 (-50%) |
| Susp. travel max [mm] | 11 | 14.1 (+28%) | 14.5 (+32%) | 7.49 (-32%) |
| Tyre DLC (worst corner) [-] | 0.03 | 0.025 (-17%) | 0.0256 (-15%) | 0.0273 (-9%) |
| Min tyre load / static [-] | 0.775 | 0.77 (-1%) | 0.795 (+3%) | 0.844 (+9%) |
| Actuator power (no regen) [W] | 0 | 1.06 | 3.27 | 7.23 |
| Peak actuator force [N] | 0 | 349 | 388 | 422 |

## Motorway M13, section B (km 17.55-18.06), 60 km/h — MEASURED, 60 km/h

| Metric | Passive | Skyhook | LQR + Kalman | Preview LQR |
|---|---|---|---|---|
| Seat a_w (Wk) [m/s²] | 0.0655 | 0.0646 (-1%) | 0.0465 (-29%) | 0.0521 (-21%) |
| Seat VDV (Wk) [m/s^1.75] | 0.28 | 0.292 (+4%) | 0.212 (-24%) | 0.193 (-31%) |
| Pitch acc. (We) RMS [rad/s²] | 0.0322 | 0.0184 (-43%) | 0.0198 (-39%) | 0.0161 (-50%) |
| Roll acc. (We) RMS [rad/s²] | 0.039 | 0.0218 (-44%) | 0.0215 (-45%) | 0.0217 (-44%) |
| Pitch RMS [deg] | 0.0707 | 0.0626 (-11%) | 0.0586 (-17%) | 0.0608 (-14%) |
| Roll RMS [deg] | 0.209 | 0.2 (-4%) | 0.195 (-7%) | 0.202 (-3%) |
| Susp. travel RMS [mm] | 1.21 | 2.51 (+108%) | 2.2 (+82%) | 0.79 (-35%) |
| Susp. travel max [mm] | 7.71 | 11.5 (+49%) | 11.1 (+44%) | 4.53 (-41%) |
| Tyre DLC (worst corner) [-] | 0.0182 | 0.0171 (-6%) | 0.0187 (+3%) | 0.021 (+16%) |
| Min tyre load / static [-] | 0.827 | 0.84 (+2%) | 0.844 (+2%) | 0.848 (+2%) |
| Actuator power (no regen) [W] | 0 | 0.718 | 1.95 | 3.56 |
| Peak actuator force [N] | 0 | 318 | 343 | 301 |

## SYNTHETIC speed bump (both wheel paths) — SYNTHETIC, 25 km/h

| Metric | Passive | Skyhook | LQR + Kalman | Preview LQR |
|---|---|---|---|---|
| Seat a_w (Wk) [m/s²] | 0.93 | 0.963 (+4%) | 0.62 (-33%) | 0.6 (-36%) |
| Seat VDV (Wk) [m/s^1.75] | 3.06 | 3 (-2%) | 2.02 (-34%) | 1.9 (-38%) |
| Pitch acc. (We) RMS [rad/s²] | 0.31 | 0.204 (-34%) | 0.18 (-42%) | 0.138 (-55%) |
| Roll acc. (We) RMS [rad/s²] | 0 | 0.00112 | 0.00217 | 0.0134 |
| Pitch RMS [deg] | 0.284 | 0.144 (-49%) | 0.163 (-43%) | 0.141 (-50%) |
| Roll RMS [deg] | 0 | 0.00114 | 0.00194 | 0.0119 |
| Susp. travel RMS [mm] | 8.39 | 7.3 (-13%) | 7.73 (-8%) | 6.75 (-20%) |
| Susp. travel max [mm] | 54.3 | 59.7 (+10%) | 64.8 (+19%) | 58.3 (+7%) |
| Tyre DLC (worst corner) [-] | 0.152 | 0.172 (+13%) | 0.123 (-19%) | 0.105 (-31%) |
| Min tyre load / static [-] | 0 | 0 | 0.144 | 0.181 |
| Actuator power (no regen) [W] | 0 | 32.3 | 133 | 143 |
| Peak actuator force [N] | 0 | 1.78e+03 | 2.1e+03 | 2.2e+03 |

## SYNTHETIC pothole (left wheel path) — SYNTHETIC, 40 km/h

| Metric | Passive | Skyhook | LQR + Kalman | Preview LQR |
|---|---|---|---|---|
| Seat a_w (Wk) [m/s²] | 0.717 | 0.774 (+8%) | 0.644 (-10%) | 0.609 (-15%) |
| Seat VDV (Wk) [m/s^1.75] | 2.06 | 2.19 (+6%) | 1.83 (-11%) | 1.66 (-19%) |
| Pitch acc. (We) RMS [rad/s²] | 0.0538 | 0.046 (-15%) | 0.0424 (-21%) | 0.047 (-13%) |
| Roll acc. (We) RMS [rad/s²] | 0.117 | 0.118 (+1%) | 0.0882 (-25%) | 0.0849 (-27%) |
| Pitch RMS [deg] | 0.0332 | 0.0173 (-48%) | 0.0149 (-55%) | 0.026 (-22%) |
| Roll RMS [deg] | 0.0517 | 0.0395 (-24%) | 0.0775 (+50%) | 0.078 (+51%) |
| Susp. travel RMS [mm] | 2.32 | 2.22 (-4%) | 3.06 (+32%) | 3.06 (+32%) |
| Susp. travel max [mm] | 28.4 | 29.3 (+3%) | 38 (+34%) | 37.5 (+32%) |
| Tyre DLC (worst corner) [-] | 0.178 | 0.188 (+6%) | 0.233 (+31%) | 0.232 (+30%) |
| Min tyre load / static [-] | 0 | 0 | 0 | 0 |
| Actuator power (no regen) [W] | 0 | 3.83 | 95.4 | 106 |
| Peak actuator force [N] | 0 | 650 | 1.57e+03 | 1.56e+03 |

## SYNTHETIC one-sided bump (right wheel path) — SYNTHETIC, 40 km/h

| Metric | Passive | Skyhook | LQR + Kalman | Preview LQR |
|---|---|---|---|---|
| Seat a_w (Wk) [m/s²] | 0.103 | 0.203 (+98%) | 0.22 (+114%) | 0.166 (+62%) |
| Seat VDV (Wk) [m/s^1.75] | 0.26 | 0.49 (+89%) | 0.579 (+123%) | 0.413 (+59%) |
| Pitch acc. (We) RMS [rad/s²] | 0.142 | 0.0992 (-30%) | 0.0845 (-41%) | 0.0544 (-62%) |
| Roll acc. (We) RMS [rad/s²] | 0.26 | 0.23 (-11%) | 0.0777 (-70%) | 0.051 (-80%) |
| Pitch RMS [deg] | 0.108 | 0.0545 (-50%) | 0.0604 (-44%) | 0.0447 (-59%) |
| Roll RMS [deg] | 0.162 | 0.121 (-26%) | 0.0975 (-40%) | 0.0775 (-52%) |
| Susp. travel RMS [mm] | 5.15 | 4.73 (-8%) | 5.07 (-2%) | 4.81 (-7%) |
| Susp. travel max [mm] | 43.4 | 46.1 (+6%) | 52.1 (+20%) | 49.8 (+15%) |
| Tyre DLC (worst corner) [-] | 0.173 | 0.196 (+13%) | 0.156 (-10%) | 0.141 (-19%) |
| Min tyre load / static [-] | 0 | 0 | 0.274 | 0.309 |
| Actuator power (no regen) [W] | 0 | 13.4 | 109 | 144 |
| Peak actuator force [N] | 0 | 1.12e+03 | 1.7e+03 | 2.3e+03 |

