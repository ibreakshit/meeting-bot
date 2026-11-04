import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { rm, stat } from 'node:fs/promises';
import { promisify } from 'node:util';
import type { Logger } from 'winston';

const execute = promisify(execFile);
interface MediaStream {
  codec_type: string; codec_name: string; width?: number; height?: number;
  display_aspect_ratio?: string; sample_aspect_ratio?: string;
}
interface MediaInfo { streams: MediaStream[]; format: { duration: string; format_name: string } }

async function inspectMedia(path: string): Promise<MediaInfo> {
  const { stdout } = await execute('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', path], {
    timeout: 30000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024
  });
  return JSON.parse(stdout) as MediaInfo;
}

/** Return a smaller validated MP4 candidate, leaving the source intact until upload succeeds. */
export async function compressRecording(inputPath: string, logger: Pick<Logger, 'info' | 'warn'>): Promise<string | undefined> {
  const outputPath = `${inputPath}.${randomUUID()}.compressed.mp4`;
  let selected = false;
  try {
    const original = await inspectMedia(inputPath);
    const sourceVideo = original.streams.find(stream => stream.codec_type === 'video');
    const duration = Number(original.format.duration);
    if (!sourceVideo?.width || !sourceVideo.height || !Number.isFinite(duration) || duration <= 0) {
      throw new Error('Recording has no usable video dimensions or duration');
    }
    const originalSize = (await stat(inputPath)).size;
    await execute('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-nostdin', '-n',
      '-threads', '2', '-filter_threads', '1', '-i', inputPath,
      '-map', '0:v:0', '-map', '0:a:0?',
      // Use display aspect ratio for non-square pixels, with even H.264 dimensions.
      '-vf', 'scale=w=\'trunc(min(1280,min(720*dar,iw*sar))/2)*2\':h=\'trunc(ow/dar/2)*2\',setsar=1',
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '26', '-pix_fmt', 'yuv420p', '-threads', '2',
      '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', outputPath
    ], { timeout: Math.min(7200000, Math.max(60000, duration * 2000)), killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 });
    const output = await inspectMedia(outputPath);
    const video = output.streams.find(stream => stream.codec_type === 'video');
    const audio = output.streams.find(stream => stream.codec_type === 'audio');
    const outputDuration = Number(output.format.duration);
    const outputSize = (await stat(outputPath)).size;
    const hasAudio = original.streams.some(stream => stream.codec_type === 'audio');
    const [aspectWidth, aspectHeight] = (sourceVideo.display_aspect_ratio || '').split(':').map(Number);
    const aspect = aspectWidth > 0 && aspectHeight > 0 ? aspectWidth / aspectHeight : sourceVideo.width / sourceVideo.height;
    if (!output.format.format_name.split(',').includes('mp4') || video?.codec_name !== 'h264'
      || !video.width || !video.height || video.width > 1280 || video.height > 720
      || video.height > sourceVideo.height || video.width > sourceVideo.height * aspect + 2
      || Math.abs(video.width / video.height - aspect) > aspect * 0.02
      || (hasAudio && audio?.codec_name !== 'aac')
      || !Number.isFinite(outputDuration) || outputDuration <= 0 || Math.abs(outputDuration - duration) > 0.5) {
      throw new Error('Compressed recording failed media validation');
    }
    if (outputSize <= 0 || outputSize >= originalSize) {
      logger.info('Keeping original recording because compression did not reduce its size.', { originalBytes: originalSize, compressedBytes: outputSize });
      return undefined;
    }
    selected = true;
    logger.info('Compressed recording before upload.', { originalBytes: originalSize, compressedBytes: outputSize, width: video.width, height: video.height });
    return outputPath;
  } catch (error) {
    logger.warn('Video compression unavailable; retaining original recording.', { reason: error instanceof Error ? error.message.slice(0, 512) : 'Unknown encoding failure' });
    return undefined;
  } finally {
    if (!selected) await rm(outputPath, { force: true }).catch(() => logger.warn('Unable to remove unused compression candidate.', { outputPath }));
  }
}
