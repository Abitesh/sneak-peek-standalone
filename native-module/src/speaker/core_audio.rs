use anyhow::Result;
use ca::aggregate_device_keys as agg_keys;
use cidre::{api, arc, av, cat, cf, core_audio as ca, ns, os};
use ringbuf::{
    traits::{Producer, Split},
    HeapCons, HeapProd, HeapRb,
};
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::Arc;

fn strip_audio_suffix(s: &str) -> &str {
    s.strip_suffix(":output")
        .or_else(|| s.strip_suffix(":input"))
        .unwrap_or(s)
}

struct Ctx {
    format: arc::R<av::AudioFormat>,
    producer: HeapProd<f32>,
    channels: u32,
    current_sample_rate: Arc<AtomicU32>,
    callback_invocations: Arc<AtomicU64>,
    callback_samples_pushed: Arc<AtomicU64>,
}

pub struct SpeakerInput {
    tap: ca::TapGuard,
    device: Option<ca::hardware::StartedDevice<ca::AggregateDevice>>,
    _ctx: Box<Ctx>,
    consumer: Option<HeapCons<f32>>,
    current_sample_rate: Arc<AtomicU32>,
}

impl SpeakerInput {
    pub fn new(device_id: Option<String>) -> Result<Self> {
        // 0. Gate on macOS 14.4+.
        let pi = ns::ProcessInfo::current();
        if !pi.is_os_at_least_version(api::OsVersion {
            major: 14,
            minor: 4,
            patch: 0,
        }) {
            return Err(anyhow::anyhow!(
                "CoreAudio process tap requires macOS 14.4+ (current OS lacks initExcludingProcesses:andDeviceUID:withStream:)"
            ));
        }

        // 1. Find the target output device
        let output_device = match device_id {
            Some(ref uid) if !uid.is_empty() && uid != "default" => {
                let requested_uid = strip_audio_suffix(uid);
                let devices = ca::System::devices()?;
                match devices.into_iter().find(|d| {
                    d.uid()
                        .map(|u| {
                            strip_audio_suffix(&u.to_string())
                                .eq_ignore_ascii_case(requested_uid)
                        })
                        .unwrap_or(false)
                }) {
                    Some(device) => device,
                    None => {
                        println!(
                            "[CoreAudioTap] Requested output UID '{}' not found; falling back to default output device",
                            uid
                        );
                        ca::System::default_output_device()?
                    }
                }
            }
            _ => ca::System::default_output_device()?,
        };

        let output_uid = output_device.uid()?;
        println!("[CoreAudioTap] Target device UID: {}", output_uid);
        let output_uid_ns = ns::String::with_str(&output_uid.to_string());

        // 2. Create a device-scoped tap with explicit mute behavior.
        let mut tap_desc = ca::TapDesc::alloc().init_excluding_processes_and_device(
            &ns::Array::new(),
            &output_uid_ns,
            0,
        );
        tap_desc.set_mono(true);
        tap_desc.set_mixdown(true);
        tap_desc.set_mute_behavior(ca::TapMuteBehavior::Unmuted);

        let tap = tap_desc.create_process_tap()?;
        println!("[CoreAudioTap] Tap created: {:?}", tap.uid());

        let sub_tap = cf::DictionaryOf::with_keys_values(
            &[ca::sub_device_keys::uid()],
            &[tap.uid().unwrap().as_type_ref()],
        );

        // 3. Create aggregate device descriptor.
        let agg_name = cf::String::from_str("NativelySystemAudioTap");
        let agg_uid = cf::Uuid::new().to_cf_string();

        let sub_device = cf::DictionaryOf::with_keys_values(
            &[ca::sub_device_keys::uid()],
            &[output_uid.as_type_ref()],
        );
        let sub_device_arr = cf::ArrayOf::from_slice(&[sub_device.as_ref()]);
        let sub_tap_arr = cf::ArrayOf::from_slice(&[sub_tap.as_ref()]);

        let agg_desc = cf::DictionaryOf::with_keys_values(
            &[
                agg_keys::is_private(),
                agg_keys::is_stacked(),
                agg_keys::tap_auto_start(),
                agg_keys::name(),
                agg_keys::main_sub_device(),
                agg_keys::uid(),
                agg_keys::sub_device_list(),
                agg_keys::tap_list(),
            ],
            &[
                cf::Boolean::value_true().as_type_ref(),
                cf::Boolean::value_false().as_type_ref(),
                cf::Boolean::value_true().as_type_ref(),
                agg_name.as_type_ref(),
                output_uid.as_type_ref(),
                agg_uid.as_type_ref(),
                sub_device_arr.as_type_ref(),
                sub_tap_arr.as_type_ref(),
            ],
        );

        let asbd = tap
            .asbd()
            .map_err(|_| anyhow::anyhow!("Failed to get ASBD from tap"))?;

        let format = av::AudioFormat::with_asbd(&asbd).unwrap();
        let channels = asbd.channels_per_frame;

        println!(
            "[CoreAudioTap] Format: {}Hz, {}ch",
            asbd.sample_rate, channels
        );

        let buffer_size = 1024 * 128;
        let rb = HeapRb::<f32>::new(buffer_size);
        let (producer, consumer) = rb.split();

        let current_sample_rate = Arc::new(AtomicU32::new(asbd.sample_rate as u32));
        let callback_invocations = Arc::new(AtomicU64::new(0));
        let callback_samples_pushed = Arc::new(AtomicU64::new(0));

        let mut ctx = Box::new(Ctx {
            format,
            producer,
            channels,
            current_sample_rate: current_sample_rate.clone(),
            callback_invocations: callback_invocations.clone(),
            callback_samples_pushed: callback_samples_pushed.clone(),
        });

        let agg_device = ca::AggregateDevice::with_desc(&agg_desc)?;

        let proc_id = agg_device.create_io_proc_id(proc, Some(&mut *ctx))?;
        let started_device = ca::device_start(agg_device, Some(proc_id))?;

        println!("[CoreAudioTap] Aggregate device started successfully");

        Ok(Self {
            tap,
            device: Some(started_device),
            _ctx: ctx,
            consumer: Some(consumer),
            current_sample_rate,
        })
    }

    pub fn stream(self) -> Result<SpeakerStream> {
        let callback_invocations = self._ctx.callback_invocations.clone();
        let callback_samples_pushed = self._ctx.callback_samples_pushed.clone();

        Ok(SpeakerStream {
            consumer: self.consumer,
            _device: self.device,
            _ctx: self._ctx,
            _tap: self.tap,
            current_sample_rate: self.current_sample_rate,
            callback_invocations,
            callback_samples_pushed,
        })
    }
}

extern "C" fn proc(
    _device: ca::Device,
    _now: &cat::AudioTimeStamp,
    input_data: &cat::AudioBufList<1>,
    _input_time: &cat::AudioTimeStamp,
    _output_data: &mut cat::AudioBufList<1>,
    _output_time: &cat::AudioTimeStamp,
    ctx: Option<&mut Ctx>,
) -> os::Status {
    let ctx = ctx.unwrap();

    let callback_number = ctx
        .callback_invocations
        .fetch_add(1, Ordering::Relaxed)
        + 1;

    // ------------------------------------------------------------
    // TEMPORARY CORE AUDIO BUFFER DIAGNOSTIC
    //
    // Only inspect/log the first 3 callbacks and every 500th callback.
    // This does not alter the audio path.
    // ------------------------------------------------------------

    let should_diagnose =
        callback_number <= 3 || callback_number % 500 == 0;

    if should_diagnose {
        eprintln!(
            "[CoreAudio-DIAG] callback={} number_buffers={}",
            callback_number,
            input_data.number_buffers
        );

        let buffer = &input_data.buffers[0];

        let channels = buffer.number_channels;
        let bytes = buffer.data_bytes_size as usize;
        let ptr_null = buffer.data.is_null();

        let bytes_per_sample = std::mem::size_of::<f32>();

        let estimated_frames = if channels > 0 {
            bytes / (channels as usize * bytes_per_sample)
        } else {
            0
        };

        eprintln!(
            "[CoreAudio-DIAG] callback={} buffer0 channels={} bytes={} ptr_null={} estimated_frames={}",
            callback_number,
            channels,
            bytes,
            ptr_null,
            estimated_frames
        );
    }

    // BUGFIX: Do NOT overwrite with the aggregate device actual_sample_rate().
    // The tap ASBD is the source of truth for the input buffer format.
    ctx.current_sample_rate
        .store(ctx.format.absd().sample_rate as u32, Ordering::Release);

    // ------------------------------------------------------------
    // PRIMARY CIDRE AudioPcmBuf PATH
    // ------------------------------------------------------------

    match av::AudioPcmBuf::with_buf_list_no_copy(&ctx.format, input_data, None) {
        Some(view) => {
            if should_diagnose {
                eprintln!(
                    "[CoreAudio-DIAG] callback={} AudioPcmBuf conversion=SUCCESS",
                    callback_number
                );
            }

            match view.data_f32_at(0) {
                Some(data) => {
                    if should_diagnose {
                        let stats = calculate_f32_stats(data);

                        eprintln!(
                            "[CoreAudio-DIAG] callback={} f32_slice_len={} first={:.6} min={:.6} max={:.6} rms={:.6} all_zero={}",
                            callback_number,
                            data.len(),
                            stats.first,
                            stats.min,
                            stats.max,
                            stats.rms,
                            stats.all_zero
                        );
                    }

                    let buffer_channels = input_data.buffers[0].number_channels;
                    let actual_ch = buffer_channels.max(1);

                    let pushed = push_audio(ctx, data, actual_ch);

                    ctx.callback_samples_pushed
                        .fetch_add(pushed as u64, Ordering::Relaxed);

                    if should_diagnose {
                        eprintln!(
                            "[CoreAudio-DIAG] callback={} pushed={}",
                            callback_number,
                            pushed
                        );
                    }
                }

                None => {
                    if should_diagnose {
                        eprintln!(
                            "[CoreAudio-DIAG] callback={} AudioPcmBuf data_f32_at(0)=NONE",
                            callback_number
                        );
                    }
                }
            }
        }

        None => {
            if should_diagnose {
                eprintln!(
                    "[CoreAudio-DIAG] callback={} AudioPcmBuf conversion=FAILED",
                    callback_number
                );
            }

            // --------------------------------------------------------
            // MANUAL F32 FALLBACK
            // --------------------------------------------------------

            if ctx.format.common_format() == av::audio::CommonFormat::PcmF32 {
                let first_buffer = &input_data.buffers[0];

                let byte_count = first_buffer.data_bytes_size as usize;
                let float_count = byte_count / std::mem::size_of::<f32>();

                if should_diagnose {
                    eprintln!(
                        "[CoreAudio-DIAG] callback={} MANUAL-F32 fallback byte_count={} float_count={} channels={} ptr_null={}",
                        callback_number,
                        byte_count,
                        float_count,
                        first_buffer.number_channels,
                        first_buffer.data.is_null()
                    );
                }

                if float_count > 0 && !first_buffer.data.is_null() {
                    let data = unsafe {
                        std::slice::from_raw_parts(
                            first_buffer.data as *const f32,
                            float_count,
                        )
                    };

                    if should_diagnose {
                        let stats = calculate_f32_stats(data);

                        eprintln!(
                            "[CoreAudio-DIAG] callback={} MANUAL-F32 first={:.6} min={:.6} max={:.6} rms={:.6} all_zero={}",
                            callback_number,
                            stats.first,
                            stats.min,
                            stats.max,
                            stats.rms,
                            stats.all_zero
                        );
                    }

                    let buffer_channels = first_buffer.number_channels;
                    let actual_ch = buffer_channels.max(1);

                    let pushed = push_audio(ctx, data, actual_ch);

                    ctx.callback_samples_pushed
                        .fetch_add(pushed as u64, Ordering::Relaxed);

                    if should_diagnose {
                        eprintln!(
                            "[CoreAudio-DIAG] callback={} MANUAL-F32 pushed={}",
                            callback_number,
                            pushed
                        );
                    }
                }
            } else if should_diagnose {
                eprintln!(
                    "[CoreAudio-DIAG] callback={} conversion failed AND format is not PcmF32; manual fallback NOT used",
                    callback_number
                );
            }
        }
    }

    os::Status::NO_ERR
}

// ------------------------------------------------------------
// Temporary diagnostic statistics.
//
// This operates only on the already-created F32 slice.
// No mutation or allocation is performed.
// ------------------------------------------------------------

struct F32Stats {
    first: f32,
    min: f32,
    max: f32,
    rms: f32,
    all_zero: bool,
}

#[inline(always)]
fn calculate_f32_stats(data: &[f32]) -> F32Stats {
    if data.is_empty() {
        return F32Stats {
            first: 0.0,
            min: 0.0,
            max: 0.0,
            rms: 0.0,
            all_zero: true,
        };
    }

    let first = data[0];

    let mut min = first;
    let mut max = first;
    let mut sum_sq = 0.0f64;
    let mut all_zero = true;

    for &sample in data {
        if sample < min {
            min = sample;
        }

        if sample > max {
            max = sample;
        }

        if sample != 0.0 {
            all_zero = false;
        }

        let value = sample as f64;
        sum_sq += value * value;
    }

    let rms = (sum_sq / data.len() as f64).sqrt() as f32;

    F32Stats {
        first,
        min,
        max,
        rms,
        all_zero,
    }
}

#[inline(always)]
fn push_audio(ctx: &mut Ctx, data: &[f32], channels: u32) -> usize {
    if channels <= 1 {
        ctx.producer.push_slice(data)
    } else {
        let ch = channels as usize;
        let frame_count = data.len() / ch;
        let mut pushed = 0usize;

        for i in 0..frame_count {
            let base = i * ch;
            let mut sum: f32 = 0.0;

            for c in 0..ch {
                sum += data[base + c];
            }

            let mono = sum / channels as f32;

            if ctx.producer.try_push(mono).is_ok() {
                pushed += 1;
            }
        }

        pushed
    }
}

pub struct SpeakerStream {
    consumer: Option<HeapCons<f32>>,
    _device: Option<ca::hardware::StartedDevice<ca::AggregateDevice>>,
    _ctx: Box<Ctx>,
    _tap: ca::TapGuard,
    current_sample_rate: Arc<AtomicU32>,
    callback_invocations: Arc<AtomicU64>,
    callback_samples_pushed: Arc<AtomicU64>,
}

impl SpeakerStream {
    pub fn callback_stats(&self) -> (Arc<AtomicU64>, Arc<AtomicU64>) {
        (
            self.callback_invocations.clone(),
            self.callback_samples_pushed.clone(),
        )
    }

    pub fn sample_rate(&self) -> u32 {
        self.current_sample_rate.load(Ordering::Acquire)
    }

    pub fn take_consumer(&mut self) -> Option<HeapCons<f32>> {
        self.consumer.take()
    }

    /// Pause the aggregate device without destroying it.
    /// Allows fast restart without the 1-second audio mute.
    /// NOTE: This is a one-way operation for CoreAudio — resume() is not supported.
    pub fn pause(&mut self) {
        self._device = None;
        println!("[CoreAudioTap] Device paused (aggregate device preserved in HAL)");
    }

    /// Resume is not supported for CoreAudio aggregate devices — they must be fully recreated.
    /// Callers should detect this and recreate the SpeakerInput/SpeakerStream.
    pub fn resume(&mut self) -> Result<()> {
        if self._device.is_none() {
            println!(
                "[CoreAudioTap] Resume not supported — aggregate device needs full recreation"
            );

            return Err(anyhow::anyhow!(
                "CoreAudio aggregate device resume not supported — recreate required"
            ));
        }

        Ok(())
    }
}

impl Drop for SpeakerStream {
    fn drop(&mut self) {
        // `_device` is stopped when dropped — either by explicit `pause()`
        // or when `SpeakerStream` itself is destroyed.
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Regression test for issue #249: pins the runtime version-gate contract.
    #[test]
    fn os_version_gate_resolves_macos_14_4_on_modern_hosts() {
        assert!(
            api::OsVersion {
                major: 14,
                minor: 4,
                patch: 0
            }
            .at_least(),
            "macOS 14.4 should report at_least() == true on a >=14.4 host"
        );
    }

    /// Inverse direction: a fictitious far-future macOS must report false.
    #[test]
    fn os_version_gate_rejects_future_version() {
        assert!(
            !api::OsVersion {
                major: 99,
                minor: 0,
                patch: 0
            }
            .at_least(),
            "macOS 99.0 must not report at_least() == true"
        );
    }

    /// Same contract via ProcessInfo.
    #[test]
    fn process_info_is_os_at_least_14_4_on_modern_hosts() {
        let pi = ns::ProcessInfo::current();

        assert!(
            pi.is_os_at_least_version(api::OsVersion {
                major: 14,
                minor: 4,
                patch: 0
            }),
            "ProcessInfo.isOperatingSystemAtLeastVersion(14.4) must be true on a >=14.4 host"
        );

        assert!(
            !pi.is_os_at_least_version(api::OsVersion {
                major: 99,
                minor: 0,
                patch: 0
            }),
            "ProcessInfo.isOperatingSystemAtLeastVersion(99.0) must be false"
        );
    }
}