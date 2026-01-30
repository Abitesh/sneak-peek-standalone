use std::collections::VecDeque;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Copy, PartialEq)]
enum VadState {
    Idle,
    Speech,
    Hangover,
}

use crate::audio_config::{VAD_START_RMS, VAD_END_RMS, VAD_HANGOVER_MS, VAD_PREROLL_CHUNKS};

pub struct VadGate {
    state: VadState,
    start_threshold: f32,
    end_threshold: f32,
    hangover_duration_ms: u128,
    max_preroll_chunks: usize,
    
    // State
    hangover_start_time: u128,
    preroll_buffer: VecDeque<Vec<i16>>,
    
    // Debug
    pub last_rms: f32,
}

impl VadGate {
    pub fn new() -> Self {
        Self {
            state: VadState::Idle,
            start_threshold: VAD_START_RMS,
            end_threshold: VAD_END_RMS,
            hangover_duration_ms: VAD_HANGOVER_MS,
            max_preroll_chunks: VAD_PREROLL_CHUNKS,
            hangover_start_time: 0,
            preroll_buffer: VecDeque::new(),
            last_rms: 0.0,
        }
    }

    pub fn process(&mut self, chunk: Vec<i16>) -> Vec<Vec<i16>> {
        let rms = self.calculate_rms(&chunk);
        self.last_rms = rms;

        let mut output = Vec::new();
        let now = self.current_time_ms();

        match self.state {
            VadState::Idle => {
                if rms > self.start_threshold {
                    // Transition to SPEECH
                    self.state = VadState::Speech;
                    println!("[VAD] Triggered: IDLE -> SPEECH (RMS: {})", rms as i32);
                    
                    // Flush pre-roll + current chunk
                    output.extend(self.preroll_buffer.drain(..));
                    output.push(chunk);
                } else {
                    // Stay IDLE, maintain buffer
                    self.preroll_buffer.push_back(chunk);
                    if self.preroll_buffer.len() > self.max_preroll_chunks {
                        self.preroll_buffer.pop_front();
                    }
                }
            }
            VadState::Speech => {
                if rms < self.end_threshold {
                    // Transition to HANGOVER
                    self.state = VadState::Hangover;
                    self.hangover_start_time = now;
                    // println!("[VAD] Hysteresis: SPEECH -> HANGOVER (RMS: {})", rms as i32);
                }
                // Always emit in speech
                output.push(chunk);
            }
            VadState::Hangover => {
                if rms > self.start_threshold {
                    // Back to SPEECH
                    self.state = VadState::Speech;
                    // println!("[VAD] Resumed: HANGOVER -> SPEECH (RMS: {})", rms as i32);
                    output.push(chunk);
                } else {
                    // Check duration
                    let time_in_hangover = now - self.hangover_start_time;
                    
                    if time_in_hangover > self.hangover_duration_ms {
                        // Transition to IDLE
                        self.state = VadState::Idle;
                        println!("[VAD] Silenced: HANGOVER -> IDLE");
                        
                        // Start buffering this chunk for next utterance (don't emit clipped tail)
                        self.preroll_buffer.push_back(chunk);
                        if self.preroll_buffer.len() > self.max_preroll_chunks {
                            self.preroll_buffer.pop_front();
                        }
                    } else {
                        // Still in hangover, keep emitting
                        output.push(chunk);
                    }
                }
            }
        }

        output
    }

    pub fn reset(&mut self) {
        self.state = VadState::Idle;
        self.preroll_buffer.clear();
    }

    fn calculate_rms(&self, data: &[i16]) -> f32 {
        if data.is_empty() {
            return 0.0;
        }

        let step = 10;
        let mut sum: f32 = 0.0;
        let mut count = 0;
        
        let mut i = 0;
        while i < data.len() {
             let sample = data[i] as f32;
             sum += sample * sample;
             count += 1;
             i += step;
        }

        if count == 0 {
            return 0.0;
        }

        (sum / count as f32).sqrt()
    }

    fn current_time_ms(&self) -> u128 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
    }
}
