pub const SAMPLE_RATE: u32 = 16_000;
pub const CHUNK_MS: u32 = 100;
pub const CHUNK_SAMPLES: usize = 1600; // 16000 * 0.1
pub const VAD_START_RMS: f32 = 100.0;
pub const VAD_END_RMS: f32 = 50.0;
pub const VAD_PREROLL_CHUNKS: usize = 3;
pub const VAD_HANGOVER_MS: u128 = 500;
