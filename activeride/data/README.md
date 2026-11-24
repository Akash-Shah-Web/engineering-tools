# Data sources

Reproduce with `python scripts/fetch_data.py` (writes `data/fetch_log.json`). The script records
what it could reach, verifies every download against a checksum, and only rewrites the committed
samples if a verified source was retrieved. Raw downloads go to `data/raw/` (git-ignored).

Access date for everything below: **2026-11-05**.

| # | Source | Role | Status in this build |
|---|---|---|---|
| 1 | LTPP InfoPave longitudinal profiles | requested main road input | **BLOCKED / NOT USED** |
| 2 | LiRA-CD P79 reference data (DTU) | **main road input actually used (MEASURED)** | used (verified excerpts) |
| 3 | Warwick suspension benchmark (Zenodo) | check against measured displacement | **BLOCKED / NOT USED** |
| 4 | Synthetic obstacles | labelled test inputs | generated in code (SYNTHETIC) |

---

## 1. LTPP InfoPave: requested, not available

* URL: https://infopave.fhwa.dot.gov/ (FHWA Long-Term Pavement Performance program)
* Licence: US federal government data; no copyright licence statement was retrievable.
* **Why it is not used:** the build environment's network policy refused all connections to
  `infopave.fhwa.dot.gov` (HTTP 403 from the egress proxy; see `fetch_log.json`). Independently
  of that, InfoPave serves profile elevations through an interactive, session-based export, so
  there is no stable direct-download URL that a script could checksum. A search of public GitHub
  mirrors found only processed LTPP summary tables (IRI, distress), not wheel-path elevation
  profiles. **No LTPP data are in this repository and no result depends on LTPP.**
* To use LTPP yourself: export a longitudinal profile (left and right wheel-path elevation vs
  distance) from InfoPave, then save it as `data/raw/ltpp/<SHRP_ID>.csv`. The fetch script lists any such
  files. Wiring them in needs a small loader in `activeride/road.py`
  (`preprocess_measured(chainage, left_mm, right_mm)` already does the processing). I have not
  verified this route against a real InfoPave export.

## 2. LiRA-CD P79 wheel-path profiles: the MEASURED road input used

* Dataset: *Data subset for road condition modelling – reference data*, LiRA-CD
  (Live Road Assessment – Connected Data), Technical University of Denmark.
* DOI: **10.11583/DTU.23097002**,
  https://data.dtu.dk/articles/dataset/Data_subset_for_road_condition_modelling_-_reference_data/23097002
* Authors: A. S. Christiansen, T. S. Alstrøm, T. Brüsch, A. M. Vestergaard, J. Larsen,
  M. Pettinari, S. M. Pour, E. Kindler, U. Schlotz.
* Licence: **CC BY 4.0**. Redistribution of the small samples below is allowed with attribution.
* Instrument: Danish Road Directorate P79 profilometer (25 point lasers on a transverse beam),
  0.1 m longitudinal spacing, survey on motorway **M13** (file `m13_zp_vh.csv`, original MD5
  `d1c74b645b169dcd88ce99d71ffbb43e`). Columns used: `Laser 5 [mm]` = **left wheel path**,
  `Laser 21 [mm]` = **right wheel path** (dataset readme, transverse positions −1025 mm / +875 mm).
* **How it was obtained:** the original figshare file
  (https://ndownloader.figshare.com/files/41206187) was also blocked by the network policy. The
  script therefore falls back to **original-byte excerpts** of that file published in the public
  repository https://github.com/MingyiLiuGT/VehicleVibrationSuppression at pinned commit
  `33b1254f1f86df724dedc4ddf0ed0aed6c163813`, and verifies each excerpt's SHA-256 against that
  repository's provenance records (these hashes were made by a third party from the original
  file, so they show the excerpt is unchanged since then; they cannot be checked against
  the full file from here):

  | Section | Chainage (m) | Rows | Excerpt SHA-256 (uncompressed) |
  |---|---|---|---|
  | A | 16 551.0 – 17 155.2 | 6000 | `04e7278edca955df93530da9c25c8d763a3b0d86dade24108a8abc5e3b9cbf24` |
  | B | 17 551.0 – 18 061.1 | 5066 | `ce3a22f722501b2a058c69e8c31bb3d4385f142ca399f23ab26547837797f3ef` |
  | C | 18 551.0 – 19 061.1 | 5066 | `bf51289619e9fa3ba0e1e6b8d982b0f36c9c1a38d91c34fb0ea966f4860053d4` |

* Committed samples: `data/samples/lira_m13_{A,B,C}.csv`, about 200 kB each. They hold three
  columns copied **unchanged** from the source (distance, left mm, right mm). Checksums are in
  `data/samples/SHA256SUMS`, which `tests/test_validation.py::test_data_checksums` verifies.
* Preprocessing (in `activeride/road.py`, applied at run time, never written back):
  1. mm → m; distance re-zeroed at the section start;
  2. a least-squares straight line removed **per wheel path** (grade and cross-fall offset);
  3. linear resampling to a 0.05 m grid;
  4. a 12 m flat lead-in and an 8 m cosine taper into the profile, so the car starts in static equilibrium;
  5. a 0.25 m moving average, as a tyre-enveloping approximation (an assumption, set in the config).
  No amplitude scaling, no selection of segments by controller performance.
* Characterisation (computed here, `fig1_road_inputs`): IRI 0.66–1.20 m/km and ISO 8608 class A
  for all six wheel paths. This is a smooth, good-condition motorway, so absolute comfort values
  are small. The P79 elevation channel's own long-wavelength filtering is not documented in the
  subset readme, so content at wavelengths above roughly 50 m should not be over-interpreted.

## 3. Warwick suspension benchmark: requested, not available

* DOI: **10.5281/zenodo.17242919** (Zenodo record 17242919, "v3"); file `suspension_dataset.mat`,
  MD5 `3ee016647067d39dd8c4feb61fef47f1` (hash taken from public code that uses the dataset).
* Licence: not retrievable from this environment; check the Zenodo record before redistributing.
* **Why it is not used:** `zenodo.org` and `doi.org` were refused by the network policy (HTTP 403),
  and no public mirror of the raw `.mat` file was found. **No comparison with measured suspension
  displacement was performed, and none is reported.**
* `activeride/warwick.py` holds the intended comparison: fit a 2-DOF quarter-car to the
  measured body displacement, then compare the identified body frequency and damping with an
  ActiveRide corner. It runs automatically in `run_all.py` once the verified file is in
  `data/raw/warwick/`. The variable names it expects (`hx<C>`, `bodyxsuppressed<C>`, 250 Hz)
  come from third-party code and are unverified. Treat that module as untested.

## 4. Synthetic inputs (clearly not measured)

Generated by `activeride/road.synthetic_road`, and labelled `SYNTHETIC` in the config, tables,
figures, videos and viewer:

* speed bump: half-sine, 70 mm × 0.9 m, both wheel paths, 25 km/h;
* pothole: cosine dish, −40 mm × 0.6 m, left wheel path, 40 km/h;
* one-sided bump: half-sine, 50 mm × 1.2 m, right wheel path, 40 km/h.

These shapes are illustrative. They are not taken from any standard or measurement.
