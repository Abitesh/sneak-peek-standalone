use anyhow::Result;
use cidre::{arc, av, core_audio as ca};

pub struct Resampler {
    converter: arc::R<av::AudioConverter>,
    input_format: arc::R<av::AudioFormat>, // Keep ref
    output_format: arc::R<av::AudioFormat>, // Keep ref
}

impl Resampler {
    pub fn new(input_sample_rate: f64) -> Result<Self> {
        // Create Input ASBD (Linear PCM, Float32, Interleaved (Mono))
        let input_asbd = ca::AudioStreamBasicDescription {
            sample_rate: input_sample_rate,
            format_id: ca::AudioFormatID::LINEAR_PCM,
            format_flags: ca::AudioFormatFlags::IS_FLOAT | ca::AudioFormatFlags::IS_PACKED,
            bytes_per_packet: 4,
            frames_per_packet: 1,
            bytes_per_frame: 4,
            channels_per_frame: 1,
            bits_per_channel: 32,
            reserved: 0,
        };

        let input_format = av::AudioFormat::with_asbd(&input_asbd).ok_or_else(|| anyhow::anyhow!("Failed to create input format"))?;

        // Create Output ASBD (Linear PCM, Int16, Interleaved (Mono), 16kHz)
        let output_asbd = ca::AudioStreamBasicDescription {
            sample_rate: 16000.0,
            format_id: ca::AudioFormatID::LINEAR_PCM,
            format_flags: ca::AudioFormatFlags::IS_SIGNED_INTEGER | ca::AudioFormatFlags::IS_PACKED,
            bytes_per_packet: 2, // 16-bit
            frames_per_packet: 1,
            bytes_per_frame: 2,
            channels_per_frame: 1,
            bits_per_channel: 16,
            reserved: 0,
        };

        let output_format = av::AudioFormat::with_asbd(&output_asbd).ok_or_else(|| anyhow::anyhow!("Failed to create output format"))?;

        let converter = av::AudioConverter::with_formats(&input_format, &output_format)
            .ok_or_else(|| anyhow::anyhow!("Failed to create AudioConverter"))?;

        Ok(Self { 
            converter,
            input_format,
            output_format,
        })
    }

    pub fn resample(&mut self, input_data: &[f32]) -> Result<Vec<i16>> {
        // Prepare Input Buffer
        let frame_count = input_data.len() as u32;
        let mut input_buffer = av::AudioPcmBuf::with_fmt_frame_capacity(
            &self.input_format,
            frame_count,
        ).ok_or_else(|| anyhow::anyhow!("Failed to create input buffer"))?;
        
        input_buffer.set_frame_length(frame_count);
        
        // Copy data to input buffer
        if let Some(channel_data) = input_buffer.data_f32_at_mut(0) {
            channel_data.copy_from_slice(input_data);
        } else {
             // Fallback if data access fails?
             return Err(anyhow::anyhow!("Failed to access input buffer data"));
        }

        // Prepare Output Buffer
        // Ratio assumption: max 16k/rate. 
        let output_capacity = (frame_count as f64 * 16000.0 / self.input_format.asbd().sample_rate * 2.0) as u32 + 100;
        
        let mut output_buffer = av::AudioPcmBuf::with_fmt_frame_capacity(
            &self.output_format,
            output_capacity,
        ).ok_or_else(|| anyhow::anyhow!("Failed to create output buffer"))?;

        let mut error = None;
        
        // Simple one-shot conversion wrapper
        // Since we have all input data, we can define a block that returns it once.
        let mut sent = false;
        
        self.converter.convert_to_buf(&mut output_buffer, &mut error, |_, status| {
            if !sent {
                sent = true;
                *status = av::AudioConverterInputStatus::HaveData;
                Some(input_buffer.retained())
            } else {
                *status = av::AudioConverterInputStatus::NoDataNow;
                None
            }
        });

        if let Some(e) = error {
            return Err(anyhow::anyhow!("Resample error: {:?}", e));
        }

        let samples_out = output_buffer.frame_length() as usize;
        let mut result = Vec::with_capacity(samples_out);
        
        // 16-bit data access
        // We know format is Int16.
        // Use raw access via buffer list
        let buf_list = output_buffer.buffer_list(); 
        if buf_list.number_buffers > 0 {
            let buffer = &buf_list.buffers[0];
            if !buffer.data.is_null() && samples_out > 0 {
                 let ptr = buffer.data as *const i16;
                 unsafe {
                     let slice = std::slice::from_raw_parts(ptr, samples_out);
                     result.extend_from_slice(slice);
                 }
            }
        }

        Ok(result)
    }
}
