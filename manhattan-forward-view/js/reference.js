// Published Manhattan reference values from Mansourihanis (2026), manuscript, not yet peer reviewed.
// Used only for comparison in the panel. Nothing here is fitted to the street being viewed.

export const PAPER = {
  citation: 'Mansourihanis, O. (2026). How much of the street ahead can a driver see? Forward views from open building footprints in Manhattan and their association with injury crashes. Manuscript, not yet peer reviewed.',
  // Table 7: mean opening (degrees) by look-ahead distance, means of streets within neighborhoods.
  profile: {
    R:      [30,    40,    60,    80,   100,  120,  160,  200,  240],
    local:  [162.8, 123.5, 85.1,  67.0, 56.2, 48.8, 37.9, 30.2, 25.3],
    avenue: [177.5, 164.5, 124.2, 99.8, 85.6, 75.7, 62.0, 50.1, 41.2],
    cohenD: [0.72,  1.53,  1.47,  1.25, 1.15, 1.12, 1.10, 1.00, 0.89]
  },
  // Table 6: segment means.
  classMeans: {
    local:  { opening80: 67.2,  faceSep: 97.2,  curb: 33.2, posted: 23.93 },
    avenue: { opening80: 103.5, faceSep: 146.6, curb: 50.6, posted: 24.60 }
  },
  // Primary pre-specified crash model (Table 12, M3): IRR per SD, 95% CI. Associations, not causal effects.
  crash: {
    opening: { irr: 0.805, lo: 0.729, hi: 0.890 },
    curb:    { irr: 1.356, lo: 1.173, hi: 1.569 },
    n: '4,373 mid-block injury crashes on 4,902 segments, 2021 to 2025'
  }
};
