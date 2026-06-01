import { initDb, queryOne, getDb } from '../server/db/database.js';
import { generateVideoThumbnail } from '../server/services/thumbnail.js';
import fs from 'fs';
import path from 'path';

async function test() {
  console.log('--- STARTING THUMBNAIL GENERATION TEST ---');
  
  // 1. Init Database (running migrations)
  initDb();
  
  // 2. Query a video
  const video = queryOne('SELECT * FROM videos LIMIT 1');
  if (!video) {
    console.error('FAIL: No video found in the database. Upload a video or insert a dummy video row first.');
    process.exit(1);
  }
  
  console.log(`Testing with video ID ${video.id}: "${video.original_filename}" at path: ${video.filepath}`);
  
  if (!fs.existsSync(video.filepath)) {
    console.error(`FAIL: Video file does not exist on disk at: ${video.filepath}`);
    process.exit(1);
  }
  
  // 3. Clear thumbnail_id on this video to simulate fresh upload
  const db = getDb();
  db.prepare('UPDATE videos SET thumbnail_id = NULL WHERE id = ?').run(video.id);
  
  // 4. Trigger thumbnail generation
  try {
    const thumbId = await generateVideoThumbnail(video.filepath, video.id, video.user_id || 1, video.channel_id);
    console.log(`SUCCESS: Thumbnail generated with ID: ${thumbId}`);
    
    // 5. Verify database associations
    const updatedVideo = queryOne('SELECT thumbnail_id FROM videos WHERE id = ?', [video.id]);
    if (!updatedVideo || updatedVideo.thumbnail_id !== thumbId) {
      throw new Error(`FAIL: Video thumbnail_id is not updated. Expected ${thumbId}, got ${updatedVideo?.thumbnail_id}`);
    }
    console.log('PASS: Video thumbnail_id linked successfully in videos table.');
    
    const thumbnailRecord = queryOne('SELECT * FROM thumbnails WHERE id = ?', [thumbId]);
    if (!thumbnailRecord) {
      throw new Error(`FAIL: Thumbnail record not found in thumbnails table for ID: ${thumbId}`);
    }
    console.log('PASS: Thumbnail registered successfully in thumbnails table.');
    
    // 6. Verify file exists on disk
    if (!fs.existsSync(thumbnailRecord.filepath)) {
      throw new Error(`FAIL: Thumbnail file does not exist on disk at: ${thumbnailRecord.filepath}`);
    }
    console.log(`PASS: Thumbnail file verified on disk: ${thumbnailRecord.filepath}`);
    
    // Check dimensions or file size
    const stats = fs.statSync(thumbnailRecord.filepath);
    console.log(`PASS: Thumbnail file size: ${(stats.size / 1024).toFixed(2)} KB`);
    
    console.log('--- ALL TEST CHECKS PASSED SUCCESSFULLY ---');
    process.exit(0);
  } catch (err) {
    console.error('TEST FAILED WITH ERROR:', err);
    process.exit(1);
  }
}

test();
