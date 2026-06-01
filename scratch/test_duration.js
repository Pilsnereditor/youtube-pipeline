import ffmpeg from 'fluent-ffmpeg';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import path from 'path';

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

const videoPath = 'data/videos/1780099989831-19425.mp4';

ffmpeg.ffprobe(videoPath, (err, metadata) => {
  if (err) {
    console.error('Error reading metadata:', err);
  } else {
    console.log('Metadata structure:', Object.keys(metadata));
    console.log('Format duration:', metadata.format.duration);
    console.log('Parsed duration (seconds):', parseFloat(metadata.format.duration));
  }
});
