use anyhow::Result;
use cidre::{arc, av};
use cidre::cat::{AudioFormatFlags, AudioStreamBasicDesc, AudioFormat};

pub struct Resampler {
    converter: arc::R<av::AudioConverter>,
    input_format: arc::R<av::AudioFormat>,
    output_format: arc::R<av::AudioFormat>,
}

impl Resampler {
    pub fn new(input_sample_rate: f64) -> Result<Self> {
        let output_asbd = AudioStreamBasicDesc {
            sample_rate: 16000.0,
            format: AudioFormat::LINEAR_PCM,
            format_flags: AudioFormatFlags::IS_SIGNED_INTEGER | AudioFormatFlags::IS_PACKED,
            bytes_per_packet: 2,
            frames_per_packet: 1,
            bytes_per_frame: 2,
            channels_per_frame: 1,
            bits_per_channel: 16,
            reserved: 0,
        };
        let output_format = av::AudioFormat::with_asbd(&output_asbd).ok_or_else(|| anyhow::anyhow!("Failed to create output format"))?;

        let input_asbd = AudioStreamBasicDesc {
            sample_rate: input_sample_rate,
            format: AudioFormat::LINEAR_PCM,
            format_flags: AudioFormatFlags::IS_FLOAT | AudioFormatFlags::IS_PACKED,
            bytes_per_packet: 4,
            frames_per_packet: 1,
            bytes_per_frame: 4,
            channels_per_frame: 1,
            bits_per_channel: 32,
            reserved: 0,
        };
        let input_format = av::AudioFormat::with_asbd(&input_asbd).ok_or_else(|| anyhow::anyhow!("Failed to create input format"))?;

        let converter = av::AudioConverter::with_formats(&input_format, &output_format)
            .ok_or_else(|| anyhow::anyhow!("Failed to create AudioConverter"))?;

        Ok(Self { 
            converter,
            input_format,
            output_format,
        })
    }

    pub fn resample(&mut self, input_data: &[f32]) -> Result<Vec<i16>> {
        let frame_count = input_data.len() as u32;
        
        // Input Buffer (Use proper constructor if 'new' doesn't exist, try 'with_format')
        // Error helper suggested 'with_fmt_frame_capacity' failed, try 'with_format'
        // If 'with_format' failed, I will use `with_params`.
        // Actually, try `av::AudioPcmBuf::new` which takes `format` and `capacity`.
        // Inspecting cidre source history: usually `new`.
        let mut input_buffer = av::AudioPcmBuf::with_format(&self.input_format, frame_count)
            .ok_or_else(|| anyhow::anyhow!("Failed to create input buffer"))?;
        
        input_buffer.set_frame_len(frame_count).map_err(|e| anyhow::anyhow!("Failed to set input frame len: {:?}", e))?;
        
        // Copy f32 data via raw access to avoid method guessing
        let buf_list = input_buffer.audio_buffer_list();
        if buf_list.number_buffers > 0 {
             let ptr = buf_list.buffers[0].data as *mut f32;
             if !ptr.is_null() {
                 unsafe {
                     let dest = std::slice::from_raw_parts_mut(ptr, frame_count as usize);
                     dest.copy_from_slice(input_data);
                 }
             }
        }

        let ratio = 16000.0 / self.input_format.absd().sample_rate;
        let estimated = (frame_count as f64 * ratio * 1.5) as u32 + 100;
        // AVAudioConverter requires output capacity >= input length even when downsampling
        let out_capacity = std::cmp::max(estimated, frame_count);
        
        let mut output_buffer = av::AudioPcmBuf::with_format(&self.output_format, out_capacity)
            .ok_or_else(|| anyhow::anyhow!("Failed to create output buffer"))?;

        // Convert
        self.converter.convert_to_buf_from_buf(&mut output_buffer, &input_buffer).map_err(|e| anyhow::anyhow!("{:?}", e))?;

        // Extract i16
        let samples_out = output_buffer.frame_len() as usize;
        let mut result = Vec::with_capacity(samples_out);
        
        let buf_list = output_buffer.audio_buffer_list(); 
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
