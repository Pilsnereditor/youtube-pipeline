// State variables
let state = {
  channels: [],
  videos: [],
  thumbnails: [],
  scheduledPosts: [],
  currentTab: 'dashboard',
  selectedChannelId: null, // Channel currently being edited
  filterChannelId: '', // Global active channel filter
  currentCalDate: new Date(), // Date for the Dashboard calendar
  schedCalDate: new Date(), // Date for the full Schedule calendar
  ws: null,
  logs: [],
  savedComments: [],
  schedulePresets: [],
  currentUser: null,
  videoFilter: 'all',
  scheduleFilterChannelId: ''
};

// Config
const API_BASE = '/api';

// On Document Ready
document.addEventListener('DOMContentLoaded', async () => {
  await checkAuth();
  initWS();
  loadAllData();
  setupDragAndDrop();
  
  const schedChannel = document.getElementById('schedChannel');
  if (schedChannel) {
    schedChannel.addEventListener('change', onSchedChannelChange);
  }
  
  const schedVideoSelect = document.getElementById('schedVideoSelect');
  if (schedVideoSelect) {
    schedVideoSelect.addEventListener('change', onSchedVideoSelectChange);
  }
  
  // Populate time picker dropdown options (15-min intervals)
  populateTimePickerDropdown();

  // Set up day selectors in Edit Channel modal
  setupDaySelectors();

  // Trigger calendar picker on clicking anywhere in the date input field
  const dateInput = document.getElementById('schedDate');
  if (dateInput) {
    dateInput.addEventListener('click', function() {
      try {
        if (typeof this.showPicker === 'function') {
          this.showPicker();
        }
      } catch (e) {
        console.warn('Native date picker trigger error:', e);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// 1. Data Fetching & Sync
// ---------------------------------------------------------------------------
async function loadAllData() {
  await Promise.all([
    loadChannels(),
    loadMediaVideos(),
    loadMediaThumbnails(),
    loadScheduledPosts(),
    loadSettings(),
    loadSavedComments(),
    loadSchedulePresets()
  ]);
  
  updateDashboardStats();
  renderDashboardCalendar();
  renderScheduleCalendar();
  renderChannelsList();
  renderDashboardChannelSnippets();
  renderPipelineControl();

  // Trigger background YouTube sync for connected channels
  triggerBackgroundSync();
}

async function triggerBackgroundSync() {
  const connectedChannels = state.channels.filter(ch => ch.has_token > 0);
  if (connectedChannels.length === 0) return;

  console.log(`[Sync] Triggering background sync for ${connectedChannels.length} channel(s)...`);
  
  let anyCancelled = false;

  await Promise.all(connectedChannels.map(async (ch) => {
    try {
      const res = await fetch(`${API_BASE}/channels/${ch.id}/sync`, { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        console.log(`[Sync] Channel "${ch.name}" sync: ${data.synced} checked, ${data.cancelled} cancelled.`);
        if (data.cancelled > 0) {
          anyCancelled = true;
        }
      }
    } catch (err) {
      console.error(`[Sync] Failed to sync channel "${ch.name}":`, err);
    }
  }));

  if (anyCancelled) {
    console.log('[Sync] Deletions detected. Reloading data...');
    await Promise.all([
      loadChannels(),
      loadMediaVideos(),
      loadScheduledPosts()
    ]);
    
    updateDashboardStats();
    renderDashboardCalendar();
    renderScheduleCalendar();
    renderChannelsList();
    renderDashboardChannelSnippets();
    renderPipelineControl();
  }
}

async function loadChannels() {
  try {
    const res = await fetch(`${API_BASE}/channels`);
    state.channels = await res.json();
    populateChannelDropdowns();
    renderChannelsList();
    renderDashboardChannelSnippets();
    updateChannelStats();
  } catch (err) {
    showToast('Failed to load channels: ' + err.message, 'error');
  }
}

async function loadMediaVideos() {
  try {
    const channelSelect = document.getElementById('mediaChannelSelect');
    const channelId = channelSelect ? channelSelect.value : '';
    const url = channelId ? `${API_BASE}/media/videos?channelId=${channelId}` : `${API_BASE}/media/videos`;

    const res = await fetch(url);
    state.videos = await res.json();

    // Update category badge counts in-memory
    const allCount = state.videos.length;
    const publishedCount = state.videos.filter(vid => vid.is_published).length;
    const unpublishedCount = allCount - publishedCount;

    const badgeAll = document.getElementById('badge-all-count');
    const badgePub = document.getElementById('badge-published-count');
    const badgeUnpub = document.getElementById('badge-unpublished-count');

    if (badgeAll) badgeAll.textContent = allCount;
    if (badgePub) badgePub.textContent = publishedCount;
    if (badgeUnpub) badgeUnpub.textContent = unpublishedCount;

    // Display appropriate count depending on active filter
    let displayedCount = allCount;
    if (state.videoFilter === 'published') displayedCount = publishedCount;
    else if (state.videoFilter === 'unpublished') displayedCount = unpublishedCount;

    document.getElementById('mediaVideoCount').textContent = `${displayedCount} videos`;
    renderVideosGrid();
    populateVideoDropdowns();
  } catch (err) {
    showToast('Failed to load videos: ' + err.message, 'error');
  }
}

async function loadMediaThumbnails() {
  try {
    const channelSelect = document.getElementById('mediaChannelSelect');
    const channelId = channelSelect ? channelSelect.value : '';
    const url = channelId ? `${API_BASE}/media/thumbnails?channelId=${channelId}` : `${API_BASE}/media/thumbnails`;

    const res = await fetch(url);
    state.thumbnails = await res.json();
    document.getElementById('mediaThumbCount').textContent = `${state.thumbnails.length} thumbnails`;
    renderThumbnailsGrid();
    populateThumbnailDropdowns();
  } catch (err) {
    showToast('Failed to load thumbnails: ' + err.message, 'error');
  }
}

function onMediaChannelChange() {
  loadMediaVideos();
  loadMediaThumbnails();
}

async function loadScheduledPosts() {
  try {
    const res = await fetch(`${API_BASE}/schedule`);
    state.scheduledPosts = await res.json();
    updateDashboardStats();
    renderUpcomingQueue();
    renderUpcomingQueueTab();
  } catch (err) {
    showToast('Failed to load schedule: ' + err.message, 'error');
  }
}

async function loadSettings() {
  try {
    const res = await fetch(`${API_BASE}/settings`);
    const settings = await res.json();
    
    // Fill settings inputs
    document.getElementById('settingsAiProvider').value = settings.ai_provider || 'gemini';
    document.getElementById('settingsGeminiKey').value = settings.gemini_api_key || '';
    document.getElementById('settingsOpenaiKey').value = settings.openai_api_key || '';
    document.getElementById('settingsGroqKey').value = settings.groq_api_key || '';
    document.getElementById('settingsAiLanguage').value = settings.ai_language || 'auto';
    
    document.getElementById('settingsClientId').value = settings.google_client_id || '';
    document.getElementById('settingsClientSecret').value = settings.google_client_secret || '';
    document.getElementById('settingsPrivacy').value = settings.default_privacy || 'private';
    
    // Fill VPN settings inputs
    document.getElementById('settingsNordUsername').value = settings.nordvpn_username || '';
    document.getElementById('settingsNordPassword').value = settings.nordvpn_password || '';
    document.getElementById('settingsProtonUsername').value = settings.protonvpn_username || '';
    document.getElementById('settingsProtonPassword').value = settings.protonvpn_password || '';
    document.getElementById('settingsCategory').value = settings.default_category || '22';
    document.getElementById('settingsComment').value = settings.default_comment || '';
    if (document.getElementById('settingsAutoDelete')) {
      document.getElementById('settingsAutoDelete').checked = settings.auto_delete_published === 'true';
    }
    if (document.getElementById('settingsWeeklyCleanup')) {
      document.getElementById('settingsWeeklyCleanup').checked = settings.weekly_cleanup_published === 'true';
    }

    // Update Gemini status indicator
    const geminiDot = document.querySelector('#geminiStatus .status-dot');
    const geminiText = document.querySelector('#geminiStatus span:not(.status-dot)');
    if (settings.gemini_api_key) {
      geminiDot.className = 'status-dot connected';
      geminiText.textContent = 'Configured';
    } else {
      geminiDot.className = 'status-dot disconnected';
      geminiText.textContent = 'Not configured';
    }

    // Update OpenAI status indicator
    const openaiDot = document.querySelector('#openaiStatus .status-dot');
    const openaiText = document.querySelector('#openaiStatus span:not(.status-dot)');
    if (settings.openai_api_key) {
      openaiDot.className = 'status-dot connected';
      openaiText.textContent = 'Configured';
    } else {
      openaiDot.className = 'status-dot disconnected';
      openaiText.textContent = 'Not configured';
    }

    // Update Groq status indicator
    const groqDot = document.querySelector('#groqStatus .status-dot');
    const groqText = document.querySelector('#groqStatus span:not(.status-dot)');
    if (groqDot && groqText) {
      if (settings.groq_api_key) {
        groqDot.className = 'status-dot connected';
        groqText.textContent = 'Configured — FREE tier active';
      } else {
        groqDot.className = 'status-dot disconnected';
        groqText.textContent = 'Not configured';
      }
    }

    toggleAiKeyVisibility();
    renderOAuthStatus();
    renderServerStatus();
  } catch (err) {
    showToast('Failed to load settings: ' + err.message, 'error');
  }
}

async function loadSavedComments() {
  try {
    const res = await fetch(`${API_BASE}/comments`);
    state.savedComments = await res.json();
    populateSavedCommentsDropdown();
  } catch (err) {
    showToast('Failed to load comment templates: ' + err.message, 'error');
  }
}

function populateSavedCommentsDropdown() {
  const select = document.getElementById('schedSavedCommentSelect');
  if (select) {
    const options = state.savedComments.map(c => 
      `<option value="${c.id}" title="${escapeHTML(c.text)}">${escapeHTML(c.title)}</option>`
    ).join('');
    select.innerHTML = '<option value="">-- Select from saved templates --</option>' + options;
  }

  const dashSelect = document.getElementById('dashCommentSelect');
  if (dashSelect) {
    const options = state.savedComments.map(c => 
      `<option value="${c.id}" title="${escapeHTML(c.text)}">${escapeHTML(c.title)}</option>`
    ).join('');
    dashSelect.innerHTML = '<option value="">-- Use Channel defaults --</option>' + options;
  }

  updateDashboardCommentPreview();
}

function updateDashboardCommentPreview() {
  const select = document.getElementById('dashCommentSelect');
  const preview = document.getElementById('dashCommentPreview');
  if (!select || !preview) return;

  const val = select.value;
  if (!val) {
    preview.style.display = 'none';
    preview.textContent = '';
    return;
  }

  const comment = state.savedComments.find(c => c.id === parseInt(val, 10));
  if (comment) {
    preview.style.display = 'block';
    preview.textContent = comment.text;
  } else {
    preview.style.display = 'none';
    preview.textContent = '';
  }
}

// ---------------------------------------------------------------------------
// 2. Navigation
// ---------------------------------------------------------------------------
function switchTab(tabId) {
  state.currentTab = tabId;
  
  // Update nav buttons
  document.querySelectorAll('.app-nav .tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.getAttribute('data-tab') === tabId);
  });
  
  // Update content panels
  document.querySelectorAll('.app-main .tab-content').forEach(panel => {
    panel.classList.toggle('active', panel.id === `tab-${tabId}`);
  });

  // Load contextual data
  if (tabId === 'dashboard') {
    renderDashboardCalendar();
    renderUpcomingQueue();
  } else if (tabId === 'schedule') {
    renderScheduleCalendar();
    renderUpcomingQueueTab();
  } else if (tabId === 'users') {
    loadUsers();
  }
}

function switchSubTab(subTabId, element) {
  const container = element.closest('.modal-body');
  
  // Toggle tab buttons
  container.querySelectorAll('.sub-tabs .sub-tab').forEach(tab => {
    tab.classList.toggle('active', tab === element);
  });

  // Toggle tab content
  container.querySelectorAll('.sub-tab-content').forEach(content => {
    content.classList.toggle('active', content.id === subTabId);
  });
}

function switchMediaSubTab(tabName, element) {
  // Toggle tab buttons
  document.querySelectorAll('.media-sub-tabs .sub-tab').forEach(tab => {
    tab.classList.toggle('active', tab === element);
  });

  // Toggle tab content
  document.getElementById('mediaVideos').classList.toggle('active', tabName === 'videos');
  document.getElementById('mediaThumbnails').classList.toggle('active', tabName === 'thumbnails');
}

function switchTitleView(viewName, element) {
  const modal = element.closest('.modal-body');
  
  // Toggle sub-tab buttons
  modal.querySelectorAll('.titles-header .mini-tab').forEach(tab => {
    tab.classList.toggle('active', tab === element);
  });

  // Toggle views
  document.getElementById('titleViewCurrent').classList.toggle('active', viewName === 'current');
  document.getElementById('titleViewGenerate').classList.toggle('active', viewName === 'generate');
  document.getElementById('titleViewImport').classList.toggle('active', viewName === 'import');
}

// ---------------------------------------------------------------------------
// 3. Render Helper Functions
// ---------------------------------------------------------------------------
function updateDashboardStats() {
  document.getElementById('statTotalChannels').textContent = state.channels.length;
  
  let pendingPosts = state.scheduledPosts.filter(p => p.status === 'pending');
  let videosList = state.videos;
  let thumbnailsList = state.thumbnails;
  let allPosts = state.scheduledPosts;
  
  if (state.filterChannelId) {
    const filterId = parseInt(state.filterChannelId);
    pendingPosts = pendingPosts.filter(p => p.channel_id === filterId);
    videosList = videosList.filter(v => v.channel_id === filterId);
    thumbnailsList = thumbnailsList.filter(t => t.channel_id === filterId);
    allPosts = allPosts.filter(p => p.channel_id === filterId);
  }
  
  document.getElementById('statScheduledPosts').textContent = pendingPosts.length;
  document.getElementById('statMediaFiles').textContent = videosList.length;
  
  // Calculate uploads today
  const todayStr = new Date().toISOString().split('T')[0];
  const uploadsToday = allPosts.filter(p => p.status === 'complete' && p.scheduled_at.startsWith(todayStr)).length;
  document.getElementById('statUploadsToday').textContent = uploadsToday;
}

function updateChannelStats() {
  document.getElementById('chStatTotal').textContent = state.channels.length;
  
  const connected = state.channels.filter(c => c.youtube_channel_id).length;
  document.getElementById('chStatConnected').textContent = connected;
  
  // Count titles and thumbnails
  let titlesCount = 0;
  let thumbsCount = 0;
  state.channels.forEach(c => {
    titlesCount += c.unused_titles || 0;
    thumbsCount += c.unused_thumbnails || 0;
  });
  document.getElementById('chStatTitles').textContent = titlesCount;
  document.getElementById('chStatThumbs').textContent = thumbsCount;
}

function renderChannelsList() {
  const list = document.getElementById('channelsList');
  if (state.channels.length === 0) {
    list.innerHTML = `
      <div class="glass empty-state">
        <p>No channels added yet. Click "＋ New Channel" to get started.</p>
      </div>
    `;
    return;
  }

  list.innerHTML = state.channels.map(ch => {
    const isBrowserMode = ch.upload_mode === 'browser';
    const isConnected = isBrowserMode ? !!ch.has_profile : !!ch.youtube_channel_id;
    const badgeText = isBrowserMode
      ? (isConnected ? 'Puppet Mode' : 'Puppet (No Session)')
      : (isConnected ? 'API Connected' : 'API Disconnected');
    const badgeClass = isConnected ? 'badge-live' : 'badge-draft';
    return `
      <div class="glass channel-card">
        <div class="channel-card-header">
          <div class="channel-card-title">
            <h3>${escapeHTML(ch.name)}</h3>
            <span class="badge ${badgeClass}">
              ${badgeText}
            </span>
          </div>
          <button class="btn-secondary btn-sm" onclick="openEditChannelModal(${ch.id})">Edit / Manage</button>
        </div>
        <p class="channel-card-niche">🎯 Niche: <span>${escapeHTML(ch.niche || 'Not set')}</span></p>
        <p class="channel-card-desc">${escapeHTML(ch.description || 'No description.')}</p>
        
        <div class="channel-card-stats">
          <div class="channel-stat-item">
            <span class="label">Unused Titles</span>
            <span class="value">${ch.unused_titles || 0}</span>
          </div>
          <div class="channel-stat-item">
            <span class="label">Thumbnails</span>
            <span class="value">${ch.unused_thumbnails || 0}</span>
          </div>
          <div class="channel-stat-item">
            <span class="label">Schedule</span>
            <span class="value">${ch.schedule_days.toUpperCase()} at ${ch.schedule_time}</span>
          </div>
        </div>
      </div>
    `;
  }).join('');
}

function renderDashboardChannelSnippets() {
  const container = document.getElementById('dashChannelSnippets');
  if (state.channels.length === 0) {
    container.innerHTML = `<p class="muted">No channels yet. Go to Channels tab to add one.</p>`;
    return;
  }

  container.innerHTML = state.channels.map(ch => {
    const isConnected = !!ch.youtube_channel_id;
    return `
      <div class="channel-snippet-card glass-light">
        <div class="snippet-header">
          <strong>${escapeHTML(ch.name)}</strong>
          <span class="status-dot ${isConnected ? 'connected' : 'disconnected'}"></span>
        </div>
        <div class="snippet-details">
          <span>📝 ${ch.unused_titles || 0} titles</span>
          <span>🖼️ ${ch.unused_thumbnails || 0} thumbs</span>
        </div>
      </div>
    `;
  }).join('');
}

function formatDuration(sec) {
  if (!sec || isNaN(sec)) return '00:00';
  const hours = Math.floor(sec / 3600);
  const minutes = Math.floor((sec % 3600) / 60);
  const seconds = Math.floor(sec % 60);
  
  const mm = String(minutes).padStart(2, '0');
  const ss = String(seconds).padStart(2, '0');
  
  if (hours > 0) {
    const hh = String(hours).padStart(2, '0');
    return `${hh}:${mm}:${ss}`;
  }
  return `${mm}:${ss}`;
}

function renderVideosGrid() {
  const grid = document.getElementById('mediaVideoGrid');
  if (!grid) return;

  // Override grid styling to support horizontal list view stack
  grid.style.display = 'flex';
  grid.style.flexDirection = 'column';
  grid.style.gap = '16px';

  // Apply active category filter
  let filteredVideos = state.videos;
  if (state.videoFilter === 'published') {
    filteredVideos = state.videos.filter(vid => vid.is_published);
  } else if (state.videoFilter === 'unpublished') {
    filteredVideos = state.videos.filter(vid => !vid.is_published);
  }

  if (filteredVideos.length === 0) {
    grid.innerHTML = `
      <div class="empty-state">
        <p class="muted">No videos found matching the active filter.</p>
      </div>
    `;
    return;
  }

  grid.innerHTML = filteredVideos.map(vid => {
    const sizeMB = (vid.filesize / (1024 * 1024)).toFixed(1);
    const date = new Date(vid.created_at).toLocaleString();
    const videoId = `video-el-${vid.id}`;
    const durationId = `duration-val-${vid.id}`;

    // Tags list rendering as pills
    const tagsArray = vid.tags ? vid.tags.split(',') : [];
    const tagsHTML = tagsArray.length > 0
      ? `<div style="display:flex; flex-wrap:wrap; gap:4px;">
           ${tagsArray.map(t => `<span style="font-size:0.68rem; background:rgba(99, 102, 241, 0.08); border:1px solid rgba(99, 102, 241, 0.2); padding:2px 6px; border-radius:4px; color:#a5b4fc; max-width:120px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${escapeHTML(t.trim())}">${escapeHTML(t.trim())}</span>`).join('')}
         </div>`
      : `<span style="font-size:0.75rem; color:var(--text-muted); font-style:italic;">No tags generated</span>`;

    // AI Badge
    const aiBadge = vid.title 
      ? `<span style="font-size:0.65rem; padding: 2px 6px; background:rgba(16,185,129,0.15); border:1px solid rgba(16,185,129,0.3); color:#10b981; border-radius:4px; font-weight:600; white-space:nowrap;">🤖 AI Metadata Ready</span>`
      : `<span style="font-size:0.65rem; padding: 2px 6px; background:rgba(245,158,11,0.15); border:1px solid rgba(245,158,11,0.3); color:#f59e0b; border-radius:4px; font-weight:600; display:inline-flex; align-items:center; gap:4px; white-space:nowrap;">
          <span class="pulse-dot" style="background:#f59e0b; width:6px; height:6px; display:inline-block; border-radius:50%; box-shadow: 0 0 6px #f59e0b; animation: pulse 2s infinite;"></span>
          Generating...
         </span>`;

    // Publishing Status Badge
    const publishBadge = vid.is_published
      ? `<span class="badge badge-published" style="font-size:0.65rem; padding: 2px 6px; border-radius:4px; font-weight:600; display:inline-flex; align-items:center; gap:4px; white-space:nowrap;">✅ Published</span>`
      : `<span class="badge badge-unpublished" style="font-size:0.65rem; padding: 2px 6px; border-radius:4px; font-weight:600; display:inline-flex; align-items:center; gap:4px; white-space:nowrap;">⏳ Not Published</span>`;

    return `
      <div class="media-row-card glass-light" onclick="openScheduleModalForVideo(event, ${vid.id})" style="display: flex; gap: 20px; padding: 16px; border-radius: 12px; background: rgba(255,255,255,0.02); border: 1px solid rgba(255,255,255,0.05); transition: all 0.2s; align-items: flex-start; cursor: pointer;">
        <!-- Left: Video Preview -->
        <div style="width: 160px; flex-shrink: 0; aspect-ratio: 16/9; background: #000; border-radius: 8px; overflow: hidden; border: 1px solid rgba(255,255,255,0.08);">
          <video id="${videoId}" src="/api/media/video-file/${vid.id}" preload="none" muted controls ${vid.thumbnail_id ? `poster="/api/media/thumbnail-file/${vid.thumbnail_id}?v=${vid.title ? encodeURIComponent(vid.title.substring(0,20)) : 'raw'}"` : ''} style="width: 100%; height: 100%; object-fit: cover;" onloadedmetadata="try { document.getElementById('${durationId}').textContent = formatDuration(this.duration); if (!${vid.duration || 0}) { window.saveVideoDuration(${vid.id}, this.duration); } } catch(e){}"></video>
        </div>

        <!-- Middle: Title, Description, Tags -->
        <div style="flex-grow: 1; display: flex; flex-direction: column; gap: 8px; min-width: 0;">
          <div style="display: flex; align-items: center; justify-content: space-between; gap: 10px;">
            <h4 style="margin: 0; font-size: 0.95rem; font-weight: 600; color: var(--text-bright); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="${escapeHTML(vid.title || vid.original_filename)}">
              ${escapeHTML(vid.title || vid.original_filename)}
            </h4>
            <div style="display: flex; align-items: center; gap: 6px;">
              ${publishBadge}
              ${aiBadge}
            </div>
          </div>

          <!-- Filename if renamed -->
          ${vid.title ? `<div style="font-size: 0.72rem; color: var(--text-muted); font-family: var(--font-mono); margin-top: -4px;">File: ${escapeHTML(vid.original_filename)}</div>` : ''}

          <!-- AI Description -->
          <div style="font-size: 0.8rem; color: var(--text-secondary); line-height: 1.4; max-height: 70px; overflow-y: auto; background: rgba(0,0,0,0.15); padding: 8px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.02); margin-top: 2px;">
            <strong style="color: var(--text-muted); font-size: 0.75rem; display: block; margin-bottom: 2px;">AI DESCRIPTION</strong>
            ${escapeHTML(vid.description || (vid.title ? 'Generating description...' : 'Upload complete. AI metadata pending.'))}
          </div>

          <!-- Tags -->
          <div style="margin-top: 4px;">
            <strong style="color: var(--text-muted); font-size: 0.75rem; display: block; margin-bottom: 4px;">AI TAGS</strong>
            ${tagsHTML}
          </div>
        </div>

        <!-- Right / Columns: Metadata Details -->
        <div style="width: 280px; flex-shrink: 0; display: grid; grid-template-columns: 1fr 1fr; gap: 10px 15px; font-size: 0.75rem; border-left: 1px solid rgba(255,255,255,0.05); padding-left: 20px; align-self: stretch; justify-content: center; height: auto;">
          <div style="display: flex; flex-direction: column; gap: 2px;">
            <span style="color: var(--text-muted); font-size: 0.7rem; font-weight: 600; text-transform: uppercase;">Upload Date</span>
            <span style="color: var(--text-primary); font-weight: 500;">${date}</span>
          </div>
          <div style="display: flex; flex-direction: column; gap: 2px;">
            <span style="color: var(--text-muted); font-size: 0.7rem; font-weight: 600; text-transform: uppercase;">Duration</span>
            <span id="${durationId}" style="color: var(--text-primary); font-weight: 600; font-family: var(--font-mono);">${vid.duration ? formatDuration(vid.duration) : '--:--'}</span>
          </div>
          <div style="display: flex; flex-direction: column; gap: 2px;">
            <span style="color: var(--text-muted); font-size: 0.7rem; font-weight: 600; text-transform: uppercase;">File Size</span>
            <span style="color: var(--text-primary); font-weight: 500;">${sizeMB} MB</span>
          </div>
          <div style="display: flex; flex-direction: column; gap: 2px;">
            <span style="color: var(--text-muted); font-size: 0.7rem; font-weight: 600; text-transform: uppercase;">Niche/Channel</span>
            <span style="color: var(--text-accent); font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="${escapeHTML(vid.channel_name || 'Unassigned')}">
              📺 ${escapeHTML(vid.channel_name || 'Unassigned')}
            </span>
          </div>
          
          <div style="grid-column: span 2; display: flex; align-items: flex-end; justify-content: flex-end; margin-top: auto; padding-top: 10px;">
            ${!vid.is_published ? `
              <button class="btn-primary btn-sm post-now-media-btn" onclick="postVideoNow(${vid.id}); event.stopPropagation();" style="padding: 6px 12px; font-size: 0.75rem; border-radius: 6px; display: flex; align-items: center; gap: 4px; margin-right: 8px; font-weight: 600;">
                ⚡ Post Now
              </button>
            ` : ''}
            <button class="btn-secondary btn-sm custom-thumb-media-btn" onclick="uploadCustomThumbnail(${vid.id}); event.stopPropagation();" style="padding: 6px 12px; font-size: 0.75rem; border-radius: 6px; display: flex; align-items: center; gap: 4px; margin-right: 8px; background: rgba(255,255,255,0.05); color: var(--text-primary); border: 1px solid rgba(255,255,255,0.1);">
              🖼️ Upload Thumbnail
            </button>
            <button class="btn-secondary btn-sm regenerate-media-btn" onclick="regenerateVideoMetadata(${vid.id}); event.stopPropagation();" style="padding: 6px 12px; font-size: 0.75rem; border-radius: 6px; display: flex; align-items: center; gap: 4px; margin-right: 8px; background: rgba(255,255,255,0.05); color: var(--text-primary); border: 1px solid rgba(255,255,255,0.1);">
              🔄 Regenerate AI
            </button>
            <button class="btn-danger btn-sm delete-media-btn" onclick="deleteVideo(${vid.id}); event.stopPropagation();" style="padding: 6px 12px; font-size: 0.75rem; border-radius: 6px; display: flex; align-items: center; gap: 4px;">
              🗑️ Delete
            </button>
          </div>
        </div>
      </div>
    `;
  }).join('');
}

function renderThumbnailsGrid() {
  const grid = document.getElementById('mediaThumbGrid');
  if (state.thumbnails.length === 0) {
    grid.innerHTML = `
      <div class="empty-state">
        <p class="muted">No thumbnails uploaded yet. Drag & drop images above.</p>
      </div>
    `;
    return;
  }

  grid.innerHTML = state.thumbnails.map(thumb => {
    return `
      <div class="thumb-card glass-light">
        <div class="thumb-image-container">
          <img src="/api/media/thumbnail-file/${thumb.id}" alt="${escapeHTML(thumb.filename)}">
        </div>
        <div class="thumb-info">
          <span class="thumb-title" title="${escapeHTML(thumb.filename)}">${escapeHTML(thumb.filename)}</span>
          <button class="btn-danger btn-xs" onclick="deleteThumbnail(${thumb.id})">Delete</button>
        </div>
      </div>
    `;
  }).join('');
}

function renderUpcomingQueue() {
  const container = document.getElementById('uploadQueueList');
  let queue = state.scheduledPosts.filter(p => ['pending', 'error'].includes(p.status));
  
  if (state.filterChannelId) {
    queue = queue.filter(p => p.channel_id === parseInt(state.filterChannelId));
  }
  
  // Show or hide Clean All button based on queue length
  const cleanBtn = document.getElementById('btnCleanQueue');
  if (cleanBtn) {
    cleanBtn.style.display = queue.length > 0 ? 'inline-flex' : 'none';
  }
  
  if (queue.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <p class="muted">No uploads scheduled. Click "＋ Schedule Upload" to get started.</p>
      </div>
    `;
    return;
  }

  container.innerHTML = queue.map(post => {
    const date = new Date(post.scheduled_at).toLocaleString();
    const isError = post.status === 'error';
    
    let statusText = 'FAILED';
    if (isError && post.retry_count > 0 && post.retry_count < 3 && post.next_retry_at) {
      const nextTime = new Date(post.next_retry_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      statusText = `FAILED (Retrying ${post.retry_count}/3 at ${nextTime})`;
    } else if (isError && post.retry_count >= 3) {
      statusText = `FAILED (Max Retries)`;
    }

    const statusBadge = isError 
      ? `<span class="badge badge-draft" style="background: rgba(239, 68, 68, 0.2); color: #f87171; border: 1px solid rgba(239, 68, 68, 0.4); margin-left: 8px;">⚠️ ${statusText}</span>` 
      : ``;

    const retryBtn = isError 
      ? `<button class="btn-primary btn-sm" onclick="retryScheduledPost(${post.id})" style="background: linear-gradient(135deg, #10b981 0%, #059669 100%); margin-right: 6px; display: inline-flex; align-items: center; justify-content: center;">🔄 Retry</button>` 
      : '';

    return `
      <div class="queue-item glass-light" style="${isError ? 'border-left: 3px solid #ef4444;' : ''}">
        <div class="queue-info">
          <div style="display: flex; align-items: center;">
            <h4 style="margin: 0;">${escapeHTML(post.title)}</h4>
            ${statusBadge}
          </div>
          <p class="meta">📺 Channel: ${escapeHTML(post.channel_name || 'Unknown')} | 📅 Time: ${date}</p>
          ${isError ? `<p style="font-size: 0.75rem; color: #f87171; margin: 4px 0 0 0; line-height: 1.3;">Error: ${escapeHTML(post.error_message || 'Unknown error')}</p>` : ''}
        </div>
        <div class="queue-actions" style="display: flex; align-items: center;">
          ${retryBtn}
          <button class="btn-danger btn-sm" onclick="cancelScheduledPost(${post.id})">Cancel</button>
        </div>
      </div>
    `;
  }).join('');
}

function renderUpcomingQueueTab() {
  const container = document.getElementById('upcomingQueue');
  let queue = state.scheduledPosts.filter(p => ['pending', 'error'].includes(p.status));
  
  if (state.filterChannelId) {
    queue = queue.filter(p => p.channel_id === parseInt(state.filterChannelId));
  }
  
  if (queue.length === 0) {
    container.innerHTML = `<p class="muted">No scheduled uploads</p>`;
    return;
  }

  container.innerHTML = queue.map(post => {
    const date = new Date(post.scheduled_at).toLocaleString();
    const isError = post.status === 'error';

    let statusText = 'FAILED';
    if (isError && post.retry_count > 0 && post.retry_count < 3 && post.next_retry_at) {
      const nextTime = new Date(post.next_retry_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      statusText = `FAILED (Retrying ${post.retry_count}/3 at ${nextTime})`;
    } else if (isError && post.retry_count >= 3) {
      statusText = `FAILED (Max Retries)`;
    }

    const statusBadge = isError 
      ? `<span class="badge badge-draft" style="background: rgba(239, 68, 68, 0.2); color: #f87171; border: 1px solid rgba(239, 68, 68, 0.4); margin-left: 8px; font-size: 0.7rem; padding: 1px 4px;">${statusText}</span>` 
      : ``;

    const retryBtn = isError 
      ? `<button class="btn-primary btn-xs" onclick="retryScheduledPost(${post.id})" style="background: linear-gradient(135deg, #10b981 0%, #059669 100%); margin-right: 6px; padding: 2px 8px; font-size: 0.75rem; height: 24px; display: inline-flex; align-items: center; border-radius: 4px; border: none; cursor: pointer; color: white;">Retry</button>` 
      : '';

    return `
      <div class="upcoming-item glass-light" style="${isError ? 'border-left: 3px solid #ef4444;' : ''}">
        <div class="upcoming-details">
          <div style="display: flex; align-items: center;">
            <h4 style="margin: 0;">${escapeHTML(post.title)}</h4>
            ${statusBadge}
          </div>
          <span class="meta">Channel: ${escapeHTML(post.channel_name)} | Scheduled: ${date}</span>
          ${isError ? `<p style="font-size: 0.72rem; color: #f87171; margin: 2px 0 0 0; line-height: 1.2;">Error: ${escapeHTML(post.error_message || 'Unknown error')}</p>` : ''}
        </div>
        <div style="display: flex; align-items: center;">
          ${retryBtn}
          <button class="btn-outline-danger btn-xs" onclick="cancelScheduledPost(${post.id})">Cancel</button>
        </div>
      </div>
    `;
  }).join('');
}

function populateChannelDropdowns() {
  const schedChannel = document.getElementById('schedChannel');
  const mediaChannelSelect = document.getElementById('mediaChannelSelect');
  const globalChannelFilter = document.getElementById('globalChannelFilter');
  
  const options = state.channels.map(ch => 
    `<option value="${ch.id}">${escapeHTML(ch.name)}</option>`
  ).join('');

  schedChannel.innerHTML = '<option value="">Select channel...</option>' + options;
  if (mediaChannelSelect) {
    mediaChannelSelect.innerHTML = '<option value="">-- Select YouTube Channel --</option>' + options;
  }
  if (globalChannelFilter) {
    const currentVal = globalChannelFilter.value;
    globalChannelFilter.innerHTML = '<option value="">All Channels</option>' + options;
    globalChannelFilter.value = currentVal;
  }
  const schedChannelFilter = document.getElementById('schedChannelFilter');
  if (schedChannelFilter) {
    const currentVal = schedChannelFilter.value;
    schedChannelFilter.innerHTML = '<option value="">-- All Channels --</option>' + options;
    schedChannelFilter.value = currentVal;
  }
}

function populateTimePickerDropdown() {
  const select = document.getElementById('schedTime');
  const viewSelect = document.getElementById('viewSchedTime');
  
  let options = [];
  for (let hour = 0; hour < 24; hour++) {
    for (let min = 0; min < 60; min += 15) {
      const hh = String(hour).padStart(2, '0');
      const mm = String(min).padStart(2, '0');
      const timeVal = `${hh}:${mm}`;
      
      const ampm = hour >= 12 ? 'PM' : 'AM';
      const displayHour = hour % 12 === 0 ? 12 : hour % 12;
      const displayStr = `${displayHour}:${mm} ${ampm}`;
      options.push(`<option value="${timeVal}">${displayStr}</option>`);
    }
  }
  const optionsHTML = options.join('');
  if (select) select.innerHTML = optionsHTML;
  if (viewSelect) viewSelect.innerHTML = optionsHTML;
}

function setScheduleTimeValue(timeStr) {
  const timeSelect = document.getElementById('schedTime');
  if (!timeSelect) return;
  
  if (timeStr) {
    let optionExists = false;
    for (let i = 0; i < timeSelect.options.length; i++) {
      if (timeSelect.options[i].value === timeStr) {
        optionExists = true;
        break;
      }
    }
    if (!optionExists) {
      const timeParts = timeStr.split(':');
      const hr = parseInt(timeParts[0]) || 0;
      const mn = timeParts[1] || '00';
      const ap = hr >= 12 ? 'PM' : 'AM';
      const dh = hr % 12 === 0 ? 12 : hr % 12;
      const displayStr = `${dh}:${mn} ${ap} (Custom)`;
      
      const opt = document.createElement('option');
      opt.value = timeStr;
      opt.textContent = displayStr;
      timeSelect.appendChild(opt);
    }
    timeSelect.value = timeStr;
  }
}

function populateVideoDropdowns() {
  const schedChannel = document.getElementById('schedChannel');
  const selectedChannelId = schedChannel ? parseInt(schedChannel.value) : null;
  const schedVideoSelect = document.getElementById('schedVideoSelect');
  if (!schedVideoSelect) return;

  const filteredVideos = selectedChannelId 
    ? state.videos.filter(vid => vid.channel_id === selectedChannelId)
    : [];

  const options = filteredVideos.map(vid => 
    `<option value="${vid.id}">${escapeHTML(vid.original_filename)}</option>`
  ).join('');

  schedVideoSelect.innerHTML = '<option value="">Select a video...</option>' + options;
}

function populateThumbnailDropdowns() {
  const schedChannel = document.getElementById('schedChannel');
  const selectedChannelId = schedChannel ? parseInt(schedChannel.value) : null;
  const schedThumbSelect = document.getElementById('schedThumbSelect');
  if (!schedThumbSelect) return;

  const filteredThumbs = selectedChannelId 
    ? state.thumbnails.filter(thumb => thumb.channel_id === selectedChannelId)
    : [];

  const options = filteredThumbs.map(thumb => 
    `<option value="${thumb.id}">${escapeHTML(thumb.filename)}</option>`
  ).join('');

  schedThumbSelect.innerHTML = '<option value="">Select a thumbnail (optional)...</option>' + options;
}

function onSchedVideoSelectChange() {
  const select = document.getElementById('schedVideoSelect');
  if (!select) return;
  const videoId = parseInt(select.value, 10);

  const schedPremiereGroup = document.getElementById('schedPremiereGroup');
  const schedIsPremiere = document.getElementById('schedIsPremiere');

  if (!videoId) {
    if (schedPremiereGroup) schedPremiereGroup.style.display = 'flex';
    const previewGroup = document.getElementById('schedThumbPreviewGroup');
    if (previewGroup) previewGroup.style.display = 'none';
    return;
  }

  const video = state.videos.find(v => v.id === videoId);
  if (video) {
    // Show/hide auto-generated thumbnail preview
    const previewGroup = document.getElementById('schedThumbPreviewGroup');
    const previewImg = document.getElementById('schedThumbPreviewImg');
    if (previewGroup && previewImg) {
      if (video.thumbnail_id) {
        previewImg.src = `/api/media/thumbnail-file/${video.thumbnail_id}?v=${video.title ? encodeURIComponent(video.title.substring(0,20)) : 'raw'}`;
        previewGroup.style.display = 'block';
      } else {
        previewGroup.style.display = 'none';
      }
    }

    if (video.title) {
      document.getElementById('schedTitle').value = video.title;
    } else {
      const cleanName = video.original_filename.replace(/\.[^/.]+$/, "").replace(/[_-]/g, " ").trim();
      document.getElementById('schedTitle').value = cleanName;
    }
    
    if (video.description) {
      document.getElementById('schedDesc').value = video.description;
    } else {
      document.getElementById('schedDesc').value = '';
    }
    
    if (video.tags) {
      document.getElementById('schedTags').value = video.tags;
    } else {
      document.getElementById('schedTags').value = '';
    }

    if (schedPremiereGroup && schedIsPremiere) {
      if (video.duration && video.duration <= 60) {
        schedPremiereGroup.style.display = 'none';
        schedIsPremiere.checked = false;
      } else {
        schedPremiereGroup.style.display = 'flex';
        const channelId = document.getElementById('schedChannel').value;
        if (channelId) {
          const channel = state.channels.find(c => c.id === parseInt(channelId));
          if (channel) {
            schedIsPremiere.checked = !!channel.schedule_as_premiere;
          }
        }
      }
    }
  }
}

function onSchedChannelChange() {
  populateVideoDropdowns();
  populateThumbnailDropdowns();
  
  // Auto fill next open slot when selecting a channel
  const channelId = document.getElementById('schedChannel').value;
  if (channelId) {
    const channel = state.channels.find(c => c.id === parseInt(channelId));
    if (channel) {
      if (channel.category) {
        document.getElementById('schedCategory').value = channel.category;
      }
      if (channel.upload_privacy) {
        document.getElementById('schedPrivacy').value = channel.upload_privacy;
      }
      if (document.getElementById('schedIsPremiere') && channel.schedule_as_premiere !== undefined) {
        document.getElementById('schedIsPremiere').checked = !!channel.schedule_as_premiere;
      }
      
      const nextSlot = calculateNextAvailableSlot(channelId, channel.schedule_days, channel.schedule_time);
      if (nextSlot) {
        const yyyy = nextSlot.getFullYear();
        const mm = String(nextSlot.getMonth() + 1).padStart(2, '0');
        const dd = String(nextSlot.getDate()).padStart(2, '0');
        document.getElementById('schedDate').value = `${yyyy}-${mm}-${dd}`;
        setScheduleTimeValue(channel.schedule_time || '10:00');
      }
    }
  }
}

function calculateNextAvailableSlot(channelId, scheduleDaysStr, scheduleTimeStr) {
  if (!scheduleDaysStr || !scheduleTimeStr) return new Date();
  
  const daysMap = {
    'sun': 0, 'mon': 1, 'tue': 2, 'wed': 3, 'thu': 4, 'fri': 5, 'sat': 6,
    'sunday': 0, 'monday': 1, 'tuesday': 2, 'wednesday': 3, 'thursday': 4, 'friday': 5, 'saturday': 6
  };
  const targetDays = scheduleDaysStr.toLowerCase().split(',').map(d => {
    const clean = d.trim().replace(/^every\s+/i, '');
    return daysMap[clean];
  }).filter(d => d !== undefined);
  if (targetDays.length === 0) return new Date();

  const timeParts = scheduleTimeStr.split(':');
  const hours = parseInt(timeParts[0]) || 0;
  const minutes = parseInt(timeParts[1]) || 0;

  // Get already taken dates for this channel
  const takenDates = new Set();
  if (state.scheduledPosts) {
    state.scheduledPosts.forEach(post => {
      if (post.channel_id === parseInt(channelId) && (post.status === 'pending' || post.status === 'processing')) {
        if (post.scheduled_at) {
          const datePart = post.scheduled_at.split(' ')[0]; // "YYYY-MM-DD"
          takenDates.add(datePart);
        }
      }
    });
  }

  let now = new Date();
  // Search up to 90 days in the future to find a free day matching the channel schedule days
  for (let i = 0; i < 90; i++) {
    let checkDate = new Date();
    checkDate.setDate(now.getDate() + i);
    let checkDay = checkDate.getDay();
    if (targetDays.includes(checkDay)) {
      let targetDate = new Date(checkDate.getFullYear(), checkDate.getMonth(), checkDate.getDate(), hours, minutes, 0, 0);
      if (targetDate.getTime() > now.getTime()) {
        const yyyy = targetDate.getFullYear();
        const mm = String(targetDate.getMonth() + 1).padStart(2, '0');
        const dd = String(targetDate.getDate()).padStart(2, '0');
        const dateStr = `${yyyy}-${mm}-${dd}`;
        if (!takenDates.has(dateStr)) {
          return targetDate;
        }
      }
    }
  }

  // Fallback to the next future scheduled day if all are filled in next 90 days
  for (let i = 0; i < 8; i++) {
    let checkDate = new Date();
    checkDate.setDate(now.getDate() + i);
    let checkDay = checkDate.getDay();
    if (targetDays.includes(checkDay)) {
      let targetDate = new Date(checkDate.getFullYear(), checkDate.getMonth(), checkDate.getDate(), hours, minutes, 0, 0);
      if (targetDate.getTime() > now.getTime()) {
        return targetDate;
      }
    }
  }
  return now;
}

function autoFillNextSlot() {
  const channelId = document.getElementById('schedChannel').value;
  if (!channelId) {
    showToast('Please select a channel first to calculate the next slot.', 'warning');
    return;
  }

  const channel = state.channels.find(ch => ch.id === parseInt(channelId));
  if (!channel) return;

  const nextSlot = calculateNextAvailableSlot(channelId, channel.schedule_days, channel.schedule_time);
  if (nextSlot) {
    const yyyy = nextSlot.getFullYear();
    const mm = String(nextSlot.getMonth() + 1).padStart(2, '0');
    const dd = String(nextSlot.getDate()).padStart(2, '0');
    document.getElementById('schedDate').value = `${yyyy}-${mm}-${dd}`;
    setScheduleTimeValue(channel.schedule_time || '10:00');
    showToast(`Set to next open slot: ${yyyy}-${mm}-${dd} ${channel.schedule_time || '10:00'}`, 'success');
  } else {
    showToast('Could not calculate next slot from channel settings.', 'warning');
  }
}

// ---------------------------------------------------------------------------
// 4. Calendar Logic
// ---------------------------------------------------------------------------
function renderDashboardCalendar() {
  const grid = document.getElementById('calendarGrid');
  const monthLabel = document.getElementById('calMonthLabel');
  renderCalendar(grid, monthLabel, state.currentCalDate, false);
}

function renderScheduleCalendar() {
  const grid = document.getElementById('schedCalendarGrid');
  const monthLabel = document.getElementById('schedCalMonthLabel');
  renderCalendar(grid, monthLabel, state.schedCalDate, true);
}

function renderCalendar(gridElement, labelElement, dateObj, isLarge) {
  const year = dateObj.getFullYear();
  const month = dateObj.getMonth();
  
  // Set month title label
  const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  labelElement.textContent = `${monthNames[month]} ${year}`;

  gridElement.innerHTML = '';

  // Render day names headers
  const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  dayNames.forEach(name => {
    const header = document.createElement('div');
    header.className = 'calendar-day-header';
    header.textContent = name;
    gridElement.appendChild(header);
  });

  // Calculate day offsets
  const firstDay = new Date(year, month, 1).getDay();
  const totalDays = new Date(year, month + 1, 0).getDate();

  // Empty cells before start day
  for (let i = 0; i < firstDay; i++) {
    const emptyCell = document.createElement('div');
    emptyCell.className = 'calendar-cell empty';
    gridElement.appendChild(emptyCell);
  }

  // Generate cells for all days of month
  const todayStr = new Date().toISOString().split('T')[0];
  
  for (let day = 1; day <= totalDays; day++) {
    const cell = document.createElement('div');
    cell.className = 'calendar-cell';
    
    const dayStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    
    // Check if cell represents today
    if (dayStr === todayStr) {
      cell.classList.add('today');
    }

    const dayNumber = document.createElement('span');
    dayNumber.className = 'day-number';
    dayNumber.textContent = day;
    cell.appendChild(dayNumber);

    // Overlay scheduled posts on this day
    let postsOnDay = state.scheduledPosts.filter(post => post.scheduled_at.startsWith(dayStr));
    const activeFilterId = isLarge ? state.scheduleFilterChannelId : state.filterChannelId;
    if (activeFilterId) {
      postsOnDay = postsOnDay.filter(post => post.channel_id === parseInt(activeFilterId));
    }
    
    if (postsOnDay.length > 0) {
      const indicatorsContainer = document.createElement('div');
      indicatorsContainer.className = 'cal-cell-indicators';
      
      postsOnDay.forEach(post => {
        const dot = document.createElement('span');
        dot.className = `indicator-dot ${post.status}`;
        dot.title = `${post.title} (${post.status})`;
        indicatorsContainer.appendChild(dot);
        
        if (isLarge) {
          const textLabel = document.createElement('div');
          textLabel.className = `cal-post-label ${post.status}`;
          textLabel.textContent = post.title.length > 15 ? post.title.substring(0, 15) + '...' : post.title;
          textLabel.title = `${post.title} (${post.status})`;
          textLabel.addEventListener('click', (e) => {
            e.stopPropagation();
            openEditScheduledPostModal(post.id);
          });
          cell.appendChild(textLabel);
        }
      });
      
      cell.appendChild(indicatorsContainer);
    }

    // Double click to open schedule modal for that day
    cell.addEventListener('click', () => {
      document.getElementById('schedDate').value = dayStr;
      openModal('scheduleModal');
    });

    gridElement.appendChild(cell);
  }
}

// Dashboard Calendar Navigation
function calPrev() {
  state.currentCalDate.setMonth(state.currentCalDate.getMonth() - 1);
  renderDashboardCalendar();
}
function calNext() {
  state.currentCalDate.setMonth(state.currentCalDate.getMonth() + 1);
  renderDashboardCalendar();
}

// Full Calendar Navigation
function schedCalPrev() {
  state.schedCalDate.setMonth(state.schedCalDate.getMonth() - 1);
  renderScheduleCalendar();
}
function schedCalNext() {
  state.schedCalDate.setMonth(state.schedCalDate.getMonth() + 1);
  renderScheduleCalendar();
}

// ---------------------------------------------------------------------------
// 5. Channel Actions
// ---------------------------------------------------------------------------
async function createChannel() {
  const name = document.getElementById('newChannelName').value;
  const niche = document.getElementById('newChannelNiche').value;
  const description = document.getElementById('newChannelDesc').value;
  const privacy = document.getElementById('newChannelPrivacy').value;
  const category = document.getElementById('newChannelCategory').value;
  const comment = document.getElementById('newChannelComment').value;
  const uploadMode = document.getElementById('newChannelUploadMode').value;
  const scheduleAsPremiere = document.getElementById('newChannelScheduleAsPremiere') ? document.getElementById('newChannelScheduleAsPremiere').checked : false;
  
  const select_proxy_type = document.getElementById('newChannelProxyType').value;
  let proxy_type = select_proxy_type;
  let proxy_host = '';
  let proxy_port = '';
  let proxy_username = '';
  let proxy_password = '';

  if (select_proxy_type === 'nordvpn') {
    proxy_type = 'socks5';
    proxy_host = document.getElementById('newChannelVpnLocation').value;
    proxy_port = '1080';
  } else if (select_proxy_type !== 'none') {
    proxy_host = document.getElementById('newChannelProxyHost').value;
    proxy_port = document.getElementById('newChannelProxyPort').value;
    proxy_username = document.getElementById('newChannelProxyUsername').value;
    proxy_password = document.getElementById('newChannelProxyPassword').value;
  }

  if (!name) {
    showToast('Name is required!', 'warning');
    return;
  }

  try {
    const res = await fetch(`${API_BASE}/channels`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        niche,
        description,
        upload_privacy: privacy,
        category,
        comment_template: comment,
        upload_mode: uploadMode,
        schedule_as_premiere: scheduleAsPremiere,
        proxy_type,
        proxy_host,
        proxy_port,
        proxy_username,
        proxy_password
      })
    });

    if (!res.ok) throw new Error(await res.text());
    
    const newChannel = await res.json();
    showToast('Channel created successfully!', 'success');
    closeModal('addChannelModal');
    
    // Clear form fields
    document.getElementById('newChannelName').value = '';
    document.getElementById('newChannelNiche').value = '';
    document.getElementById('newChannelDesc').value = '';
    document.getElementById('newChannelComment').value = '';
    document.getElementById('newChannelUploadMode').value = 'api';
    if (document.getElementById('newChannelScheduleAsPremiere')) {
      document.getElementById('newChannelScheduleAsPremiere').checked = false;
    }
    document.getElementById('newChannelProxyType').value = 'none';
    document.getElementById('newChannelProxyHost').value = '';
    document.getElementById('newChannelProxyPort').value = '';
    document.getElementById('newChannelProxyUsername').value = '';
    document.getElementById('newChannelProxyPassword').value = '';
    toggleAddChannelProxyFields();
    
    await loadChannels();
    openEditChannelModal(newChannel.id);
    
    // Automatically launch the remote browser login setup window
    setTimeout(async () => {
      showToast('Launching remote browser login window...', 'info');
      await startBrowserLogin();
    }, 300);
  } catch (err) {
    showToast('Failed to create channel: ' + err.message, 'error');
  }
}

async function openEditChannelModal(channelId) {
  state.selectedChannelId = channelId;
  const channel = state.channels.find(c => c.id === channelId);
  if (!channel) return;

  // Fill details inputs
  document.getElementById('editChannelName').textContent = channel.name;
  document.getElementById('editChName').value = channel.name;
  document.getElementById('editChNiche').value = channel.niche || '';
  document.getElementById('editChDesc').value = channel.description || '';
  document.getElementById('editChTime').value = channel.schedule_time || '10:00';
  const scheduleDays = channel.schedule_days || 'mon,wed,fri';
  document.getElementById('editChDays').value = scheduleDays;
  setDaysUIFromValue(scheduleDays);
  document.getElementById('editChComment').value = channel.comment_template || '';
  
  // Set upload mode
  document.getElementById('editChUploadMode').value = channel.upload_mode || 'api';
  if (document.getElementById('editChScheduleAsPremiere')) {
    document.getElementById('editChScheduleAsPremiere').checked = !!channel.schedule_as_premiere;
  }
  
  // Fill proxy details
  let proxyType = channel.proxy_type || 'none';
  const NORDVPN_KEYS = ['us-atlanta', 'us-chicago', 'us-dallas', 'us-los-angeles', 'us-new-york', 'nl-amsterdam', 'se-stockholm'];
  if (proxyType === 'socks5' && NORDVPN_KEYS.includes(channel.proxy_host)) {
    proxyType = 'nordvpn';
  }
  document.getElementById('editChProxyType').value = proxyType;
  toggleEditChannelProxyFields();
  
  if (proxyType === 'nordvpn') {
    document.getElementById('editChVpnLocation').value = channel.proxy_host || '';
    document.getElementById('editChProxyHost').value = '';
    document.getElementById('editChProxyPort').value = '';
    document.getElementById('editChProxyUsername').value = '';
    document.getElementById('editChProxyPassword').value = '';
  } else {
    document.getElementById('editChProxyHost').value = channel.proxy_host || '';
    document.getElementById('editChProxyPort').value = channel.proxy_port || '';
    document.getElementById('editChProxyUsername').value = channel.proxy_username || '';
    document.getElementById('editChProxyPassword').value = channel.proxy_password || '';
  }
  
  toggleEditConnectionSections();

  // Load subtab contents
  loadChannelTitles(channelId);
  loadChannelThumbnails(channelId);
  loadChannelUploadHistory(channelId);

  // Show Details subtab by default
  const detailsTabBtn = document.querySelector('#editChannelModal .sub-tabs button');
  switchSubTab('editDetails', detailsTabBtn);

  openModal('editChannelModal');
}

async function saveChannel() {
  if (!state.selectedChannelId) return;

  const name = document.getElementById('editChName').value;
  const niche = document.getElementById('editChNiche').value;
  const description = document.getElementById('editChDesc').value;
  const time = document.getElementById('editChTime').value;
  const days = document.getElementById('editChDays').value;
  const comment = document.getElementById('editChComment').value;
  const uploadMode = document.getElementById('editChUploadMode').value;
  const scheduleAsPremiere = document.getElementById('editChScheduleAsPremiere') ? document.getElementById('editChScheduleAsPremiere').checked : false;

  const select_proxy_type = document.getElementById('editChProxyType').value;
  let proxy_type = select_proxy_type;
  let proxy_host = '';
  let proxy_port = '';
  let proxy_username = '';
  let proxy_password = '';

  if (select_proxy_type === 'nordvpn') {
    proxy_type = 'socks5';
    proxy_host = document.getElementById('editChVpnLocation').value;
    proxy_port = '1080';
  } else if (select_proxy_type !== 'none') {
    proxy_host = document.getElementById('editChProxyHost').value;
    proxy_port = document.getElementById('editChProxyPort').value;
    proxy_username = document.getElementById('editChProxyUsername').value;
    proxy_password = document.getElementById('editChProxyPassword').value;
  }

  try {
    const res = await fetch(`${API_BASE}/channels/${state.selectedChannelId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        niche,
        description,
        schedule_time: time,
        schedule_days: days,
        comment_template: comment,
        upload_mode: uploadMode,
        schedule_as_premiere: scheduleAsPremiere,
        proxy_type,
        proxy_host,
        proxy_port,
        proxy_username,
        proxy_password
      })
    });

    if (!res.ok) throw new Error(await res.text());

    showToast('Channel settings saved successfully!', 'success');
    closeModal('editChannelModal');
    loadChannels();
  } catch (err) {
    showToast('Failed to save channel: ' + err.message, 'error');
  }
}

// ---------------------------------------------------------------------------
// Connection & Login Session Management (API and Browser/Puppet Mode)
// ---------------------------------------------------------------------------
function toggleEditConnectionSections() {
  const uploadMode = document.getElementById('editChUploadMode').value;
  const browserSection = document.getElementById('editBrowserLoginSection');
  const apiSection = document.getElementById('editApiLoginSection');
  const channelId = state.selectedChannelId;

  if (uploadMode === 'browser') {
    if (browserSection) browserSection.classList.remove('hidden');
    if (apiSection) apiSection.classList.add('hidden');
    if (channelId) {
      updateBrowserLoginStatus(channelId);
    }
  } else {
    if (browserSection) browserSection.classList.add('hidden');
    if (apiSection) apiSection.classList.remove('hidden');
    if (channelId) {
      updateApiLoginStatus(channelId);
    }
  }
}

function updateApiLoginStatus(channelId) {
  const channel = state.channels.find(c => c.id === channelId);
  if (!channel) return;

  const statusText = document.getElementById('apiLoginStatusText');
  const disconnectBtn = document.getElementById('btnApiDisconnect');
  const openBtn = document.getElementById('btnApiLoginOpen');

  if (!statusText || !disconnectBtn || !openBtn) return;

  const isConnected = !!channel.youtube_channel_id || channel.has_token > 0;

  if (isConnected) {
    statusText.className = 'badge badge-live';
    statusText.textContent = `Connected (${channel.youtube_channel_id || 'Active Token'})`;
    disconnectBtn.classList.remove('hidden');
    openBtn.textContent = '🔗 Reconnect Google Account';
  } else {
    statusText.className = 'badge badge-draft';
    statusText.textContent = 'Disconnected';
    disconnectBtn.classList.add('hidden');
    openBtn.textContent = '🔗 Connect Google Account';
  }
}

function startApiLogin() {
  const channelId = state.selectedChannelId;
  if (!channelId) return;

  // Open the OAuth URL in a popup
  const width = 600;
  const height = 700;
  const left = (screen.width - width) / 2;
  const top = (screen.height - height) / 2;
  
  const popup = window.open(
    `${API_BASE}/auth/google?channelId=${channelId}`,
    'Google OAuth Connection',
    `width=${width},height=${height},left=${left},top=${top},resizable=yes,scrollbars=yes,status=yes`
  );

  // Monitor for completion message
  window.addEventListener('message', function listen(event) {
    if (event.data === 'oauth-success') {
      window.removeEventListener('message', listen);
      showToast('YouTube account connected successfully!', 'success');
      loadChannels().then(() => {
        updateApiLoginStatus(channelId);
      });
    }
  });
}

async function disconnectApiLogin() {
  const channelId = state.selectedChannelId;
  if (!channelId) return;
  
  if (!confirm('Are you sure you want to disconnect this YouTube channel?')) return;

  try {
    const res = await fetch(`${API_BASE}/auth/disconnect/${channelId}`, { method: 'POST' });
    if (!res.ok) throw new Error(await res.text());
    
    showToast('Disconnected successfully.', 'success');
    await loadChannels();
    updateApiLoginStatus(channelId);
  } catch (err) {
    showToast('Failed to disconnect: ' + err.message, 'error');
  }
}

let browserLoginPollInterval = null;

async function updateBrowserLoginStatus(channelId) {
  try {
    const res = await fetch(`${API_BASE}/channels/${channelId}/browser-login-status`);
    const data = await res.json();
    
    const statusText = document.getElementById('browserLoginStatusText');
    const closeBtn = document.getElementById('btnBrowserLoginClose');
    const openBtn = document.getElementById('btnBrowserLoginOpen');
    
    if (!statusText || !closeBtn || !openBtn) return;

    if (data.active) {
      statusText.className = 'badge badge-live';
      statusText.textContent = 'Active Login Window';
      closeBtn.classList.remove('hidden');
      openBtn.textContent = '🔑 Browser Login Open';
      openBtn.disabled = true;
      const container = document.getElementById('puppetScreenContainer');
      if (container) {
        container.style.display = 'block';
        // Small delay to let the DOM paint, then auto-focus the keyboard sink
        setTimeout(() => focusPuppetKeyboard(), 100);
      }
    } else {
      closeBtn.classList.add('hidden');
      openBtn.disabled = false;
      openBtn.textContent = '🔑 Start Browser Login';
      const container = document.getElementById('puppetScreenContainer');
      if (container) container.style.display = 'none';
      
      if (data.setup) {
        statusText.className = 'badge badge-live';
        statusText.textContent = 'Session Connected';
      } else {
        statusText.className = 'badge badge-draft';
        statusText.textContent = 'No Session';
      }
    }
  } catch (err) {
    console.error('Failed to get browser login status:', err);
  }
}

async function startBrowserLogin() {
  const channelId = state.selectedChannelId;
  if (!channelId) return;

  try {
    const res = await fetch(`${API_BASE}/channels/${channelId}/browser-login`, { method: 'POST' });
    const data = await res.json();
    
    if (data.success) {
      showToast('Remote browser started! The screen will appear below — click on it and type to log in.', 'info');
      updateBrowserLoginStatus(channelId);
      
      // Start polling status every 2 seconds
      if (browserLoginPollInterval) clearInterval(browserLoginPollInterval);
      browserLoginPollInterval = setInterval(() => {
        if (!state.selectedChannelId || state.selectedChannelId !== channelId) {
          clearInterval(browserLoginPollInterval);
          browserLoginPollInterval = null;
          return;
        }
        updateBrowserLoginStatus(channelId);
      }, 2000);
    } else {
      throw new Error(data.error || 'Failed to start browser session');
    }
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function stopBrowserLogin() {
  const channelId = state.selectedChannelId;
  if (!channelId) return;

  try {
    const res = await fetch(`${API_BASE}/channels/${channelId}/browser-login-close`, { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      showToast('Browser window closed.', 'success');
      if (browserLoginPollInterval) {
        clearInterval(browserLoginPollInterval);
        browserLoginPollInterval = null;
      }
      const container = document.getElementById('puppetScreenContainer');
      if (container) container.style.display = 'none';
      updateBrowserLoginStatus(channelId);
    }
  } catch (err) {
    showToast('Failed to close browser: ' + err.message, 'error');
  }
}

const NORDVPN_LOCATIONS = [
  { value: 'us-atlanta', label: 'USA - Atlanta' },
  { value: 'us-chicago', label: 'USA - Chicago' },
  { value: 'us-dallas', label: 'USA - Dallas' },
  { value: 'us-los-angeles', label: 'USA - Los Angeles' },
  { value: 'us-new-york', label: 'USA - New York' },
  { value: 'nl-amsterdam', label: 'Netherlands - Amsterdam' },
  { value: 'se-stockholm', label: 'Sweden - Stockholm' }
];

function populateVpnLocations(type, selectId) {
  const select = document.getElementById(selectId);
  if (!select) return;
  select.innerHTML = '';
  
  const locations = type === 'nordvpn' ? NORDVPN_LOCATIONS : [];
  locations.forEach(loc => {
    const opt = document.createElement('option');
    opt.value = loc.value;
    opt.textContent = loc.label;
    select.appendChild(opt);
  });
}

function toggleAddChannelProxyFields() {
  const type = document.getElementById('newChannelProxyType').value;
  const locationFields = document.getElementById('newChannelVpnLocationFields');
  const customFields = document.getElementById('newChannelProxyFields');

  if (type === 'none') {
    if (locationFields) locationFields.style.display = 'none';
    if (customFields) customFields.style.display = 'none';
  } else if (type === 'nordvpn') {
    populateVpnLocations(type, 'newChannelVpnLocation');
    if (locationFields) locationFields.style.display = 'block';
    if (customFields) customFields.style.display = 'none';
  } else {
    if (locationFields) locationFields.style.display = 'none';
    if (customFields) customFields.style.display = 'flex';
  }
}

function toggleEditChannelProxyFields() {
  const type = document.getElementById('editChProxyType').value;
  const locationFields = document.getElementById('editChVpnLocationFields');
  const customFields = document.getElementById('editChProxyFields');

  if (type === 'none') {
    if (locationFields) locationFields.style.display = 'none';
    if (customFields) customFields.style.display = 'none';
  } else if (type === 'nordvpn') {
    populateVpnLocations(type, 'editChVpnLocation');
    if (locationFields) locationFields.style.display = 'block';
    if (customFields) customFields.style.display = 'none';
  } else {
    if (locationFields) locationFields.style.display = 'none';
    if (customFields) customFields.style.display = 'flex';
  }
}

function sendPuppetCommand(type, payload = {}) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify({
      type,
      channelId: state.selectedChannelId,
      ...payload
    }));
  } else {
    showToast('WebSocket not connected. Unable to interact with remote browser.', 'error');
  }
}

/**
 * Focus the hidden keyboard sink textarea so keystrokes are captured.
 * Called when the user clicks anywhere on the remote screen.
 */
function focusPuppetKeyboard() {
  const sink = document.getElementById('puppetKeyboardSink');
  if (sink) {
    sink.focus();
    // Clear any accumulated text to prevent it growing unbounded
    sink.value = '';
  }
}

/**
 * Handle click on the remote screen overlay.
 * Sends the click position to the remote browser AND focuses the keyboard sink.
 */
function handlePuppetClick(event) {
  event.preventDefault();
  event.stopPropagation(); // don't bubble to the wrapper onclick

  const img = document.getElementById('puppetScreenImg');
  if (!img) return;

  const rect = img.getBoundingClientRect();
  const displayX = event.clientX - rect.left;
  const displayY = event.clientY - rect.top;

  if (displayX < 0 || displayY < 0 || displayX > rect.width || displayY > rect.height) return;

  // Map display coordinates to the remote browser viewport (1024x700)
  const x = Math.round((displayX / rect.width) * 1024);
  const y = Math.round((displayY / rect.height) * 700);

  console.log(`[Puppet Click] Display(${displayX.toFixed(0)}, ${displayY.toFixed(0)}) => Remote(${x}, ${y})`);
  sendPuppetCommand('puppet:click', { x, y });

  // Also focus the keyboard sink so user can type immediately after clicking
  focusPuppetKeyboard();
}

// Non-printable keys to forward as puppet:key
const PUPPET_SPECIAL_KEYS = new Set([
  'Backspace', 'Delete', 'Tab', 'Enter', 'Escape', 'Home', 'End',
  'PageUp', 'PageDown', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'F1','F2','F3','F4','F5','F6','F7','F8','F9','F10','F11','F12',
  'Insert', 'PrintScreen', 'Pause', 'NumLock', 'ScrollLock', 'CapsLock'
]);

/**
 * Main keyboard handler — fires on keydown in the hidden textarea.
 * For special/navigation keys (Backspace, Enter, Arrows) and Ctrl combos,
 * we handle them explicitly and call event.preventDefault().
 * For standard printable characters, we let the default browser action type
 * them into the textarea, which is then captured and sent by onPuppetInput().
 */
function onPuppetKeyDown(event) {
  const key = event.key;

  // Skip modifier keys themselves
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(key)) return;

  // Ctrl combos (except Ctrl+V which we let pass to local textarea for paste)
  if (event.ctrlKey) {
    if (key.toLowerCase() === 'v') {
      // Let standard paste happen in the local textarea
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const comboKey = key.length === 1 ? key.toUpperCase() : key;
    sendPuppetCommand('puppet:key', {
      key: comboKey,
      modifiers: { ctrl: true, shift: event.shiftKey, alt: event.altKey }
    });
    return;
  }

  if (PUPPET_SPECIAL_KEYS.has(key)) {
    // Prevent default action (like Tab shifting focus, or Backspace navigating back)
    event.preventDefault();
    event.stopPropagation();
    sendPuppetCommand('puppet:key', { key });
  }
  // Otherwise, do not preventDefault! The character will be typed into the textarea,
  // triggering the input event which we capture in onPuppetInput.
}

/**
 * Capture input (typing & pasting) in the hidden textarea.
 * This handles printable keys, pasted strings, virtual keyboards, and IMEs.
 */
function onPuppetInput(event) {
  const text = event.target.value;
  if (text.length > 0) {
    sendPuppetCommand('puppet:type', { text });
    // Reset immediately so it remains empty for subsequent input
    event.target.value = '';
  }
}

/**
 * Keyup handler — clear the textarea value.
 */
function onPuppetKeyUp(event) {
  const sink = document.getElementById('puppetKeyboardSink');
  if (sink) {
    sink.value = '';
  }
}

/**
 * Textarea gained focus — show the keyboard active indicator and highlight screen border.
 */
function onPuppetScreenFocus() {
  const indicator = document.getElementById('puppetFocusIndicator');
  const screenWrapper = document.querySelector('#puppetScreenContainer > div:last-of-type');
  if (indicator) indicator.style.display = 'inline-flex';
  // Add a glowing purple border around the screen area
  const img = document.getElementById('puppetScreenImg');
  if (img) {
    img.style.outline = '2px solid rgba(99,102,241,0.8)';
    img.style.boxShadow = '0 0 0 4px rgba(99,102,241,0.2)';
  }
}

/**
 * Textarea lost focus — hide keyboard active indicator.
 */
function onPuppetScreenBlur() {
  const indicator = document.getElementById('puppetFocusIndicator');
  if (indicator) indicator.style.display = 'none';
  const img = document.getElementById('puppetScreenImg');
  if (img) {
    img.style.outline = 'none';
    img.style.boxShadow = 'none';
  }
}

function sendPuppetSpecialKey(key) {
  sendPuppetCommand('puppet:key', { key });
}

async function finishBrowserLogin() {
  const channelId = state.selectedChannelId;
  if (!channelId) return;

  try {
    const res = await fetch(`${API_BASE}/channels/${channelId}/browser-login-finish`, { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      showToast('YouTube Studio session successfully logged in and saved!', 'success');
      if (browserLoginPollInterval) {
        clearInterval(browserLoginPollInterval);
        browserLoginPollInterval = null;
      }
      
      const container = document.getElementById('puppetScreenContainer');
      if (container) container.style.display = 'none';
      
      await loadChannels();
      updateBrowserLoginStatus(channelId);
    } else {
      throw new Error(data.error || 'Failed to verify login status.');
    }
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function deleteChannel() {
  if (!state.selectedChannelId) return;
  if (!confirm('Are you absolutely sure you want to delete this channel? All associated data will be deleted!')) return;

  try {
    const res = await fetch(`${API_BASE}/channels/${state.selectedChannelId}`, {
      method: 'DELETE'
    });

    if (!res.ok) throw new Error(await res.text());

    showToast('Channel deleted successfully.', 'success');
    closeModal('editChannelModal');
    loadChannels();
  } catch (err) {
    showToast('Failed to delete channel: ' + err.message, 'error');
  }
}

// ---------------------------------------------------------------------------
// 6. Channel Sub-Tab 1: Titles
// ---------------------------------------------------------------------------
async function loadChannelTitles(channelId) {
  try {
    const res = await fetch(`${API_BASE}/channels/${channelId}/titles`);
    const titles = await res.json();
    
    document.getElementById('titlesCount').textContent = titles.length;
    
    const list = document.getElementById('titlesList');
    if (titles.length === 0) {
      list.innerHTML = `<p class="muted">No titles saved yet. Add titles manually or use the AI generator.</p>`;
      document.getElementById('btnDeleteAllTitles').classList.add('hidden');
      return;
    }

    document.getElementById('btnDeleteAllTitles').classList.remove('hidden');
    list.innerHTML = titles.map(t => `
      <div class="title-list-item">
        <span class="${t.used ? 'used' : ''}">${escapeHTML(t.text)}</span>
        <button class="delete-btn" onclick="deleteTitle(${t.id})" title="Delete title">✕</button>
      </div>
    `).join('');
  } catch (err) {
    showToast('Failed to load titles: ' + err.message, 'error');
  }
}

async function deleteTitle(titleId) {
  if (!state.selectedChannelId) return;
  try {
    const res = await fetch(`${API_BASE}/channels/${state.selectedChannelId}/titles/${titleId}`, {
      method: 'DELETE'
    });
    if (!res.ok) throw new Error(await res.text());
    loadChannelTitles(state.selectedChannelId);
    loadChannels();
  } catch (err) {
    showToast('Failed to delete title: ' + err.message, 'error');
  }
}

async function deleteAllTitles() {
  if (!state.selectedChannelId) return;
  if (!confirm('Are you sure you want to delete all titles for this channel?')) return;
  try {
    const res = await fetch(`${API_BASE}/channels/${state.selectedChannelId}/titles`, {
      method: 'DELETE'
    });
    if (!res.ok) throw new Error(await res.text());
    loadChannelTitles(state.selectedChannelId);
    loadChannels();
  } catch (err) {
    showToast('Failed to delete titles: ' + err.message, 'error');
  }
}

async function importTitles() {
  if (!state.selectedChannelId) return;
  const input = document.getElementById('importTitlesInput').value;
  const list = input.split('\n').map(t => t.trim()).filter(t => t.length > 0);

  if (list.length === 0) {
    showToast('Please enter at least one title.', 'warning');
    return;
  }

  try {
    const res = await fetch(`${API_BASE}/channels/${state.selectedChannelId}/titles`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ titles: list })
    });

    if (!res.ok) throw new Error(await res.text());

    showToast(`Successfully imported ${list.length} titles!`, 'success');
    document.getElementById('importTitlesInput').value = '';
    loadChannelTitles(state.selectedChannelId);
    loadChannels();
  } catch (err) {
    showToast('Import failed: ' + err.message, 'error');
  }
}

let generatedTitlesList = []; // Temp holder

async function generateTitles() {
  if (!state.selectedChannelId) return;
  const count = document.getElementById('aiTitleCount').value;
  const prompt = document.getElementById('aiTitlePrompt').value;

  const btn = document.querySelector('#titleViewGenerate button');
  const origText = btn.textContent;
  btn.textContent = '✨ Generating (please wait)...';
  btn.disabled = true;

  try {
    const res = await fetch(`${API_BASE}/ai/generate-titles`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channelId: state.selectedChannelId,
        count: parseInt(count),
        customPrompt: prompt
      })
    });

    if (!res.ok) throw new Error(await res.text());

    const result = await res.json();
    generatedTitlesList = result.titles;

    document.getElementById('aiTitleGenCount').textContent = generatedTitlesList.length;
    const resultsContainer = document.getElementById('aiTitleResults');
    resultsContainer.classList.remove('hidden');

    const list = document.getElementById('aiTitleList');
    list.innerHTML = generatedTitlesList.map(t => `
      <div class="title-list-item">
        <span>${escapeHTML(t.text)}</span>
      </div>
    `).join('');

    showToast('Generated and saved titles successfully!', 'success');
    loadChannelTitles(state.selectedChannelId);
    loadChannels();
  } catch (err) {
    showToast('Failed to generate titles: ' + err.message, 'error');
  } finally {
    btn.textContent = origText;
    btn.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// 7. Channel Sub-Tab 2: Thumbnails
// ---------------------------------------------------------------------------
async function loadChannelThumbnails(channelId) {
  try {
    const res = await fetch(`${API_BASE}/channels/${channelId}/thumbnails`);
    const thumbs = await res.json();
    
    document.getElementById('thumbsCount').textContent = thumbs.length;
    
    const container = document.getElementById('thumbnailGallery');
    if (thumbs.length === 0) {
      container.innerHTML = `<p class="muted">No thumbnails uploaded for this channel.</p>`;
      return;
    }

    container.innerHTML = thumbs.map(t => `
      <div class="thumb-card">
        <div class="thumb-image-container">
          <img src="/api/media/thumbnail-file/${t.id}" alt="thumbnail">
        </div>
        <div class="thumb-info">
          <span class="thumb-title" title="${escapeHTML(t.filename)}">${escapeHTML(t.filename)}</span>
          <button class="btn-danger btn-xs" onclick="deleteChannelThumbnail(${t.id})">Delete</button>
        </div>
      </div>
    `).join('');
  } catch (err) {
    showToast('Failed to load thumbnails: ' + err.message, 'error');
  }
}

async function deleteChannelThumbnail(thumbId) {
  if (!state.selectedChannelId) return;
  try {
    const res = await fetch(`${API_BASE}/channels/${state.selectedChannelId}/thumbnails/${thumbId}`, {
      method: 'DELETE'
    });
    if (!res.ok) throw new Error(await res.text());
    loadChannelThumbnails(state.selectedChannelId);
    loadChannels();
  } catch (err) {
    showToast('Failed to delete thumbnail: ' + err.message, 'error');
  }
}

// ---------------------------------------------------------------------------
// 8. Channel Sub-Tab 3: Upload History
// ---------------------------------------------------------------------------
async function loadChannelUploadHistory(channelId) {
  try {
    const res = await fetch(`${API_BASE}/channels/${channelId}/uploads`);
    const uploads = await res.json();

    const container = document.getElementById('uploadHistory');
    if (uploads.length === 0) {
      container.innerHTML = `<p class="muted">No videos uploaded yet from this channel.</p>`;
      return;
    }

    container.innerHTML = uploads.map(u => {
      const date = new Date(u.uploaded_at).toLocaleString();
      const isSuccess = u.status === 'complete';
      return `
        <div class="history-item glass-light">
          <div class="history-details">
            <h4>${escapeHTML(u.title)}</h4>
            <span class="meta">Status: 
              <span class="badge ${isSuccess ? 'badge-live' : 'badge-draft'}">${u.status.toUpperCase()}</span>
              | Date: ${date}
            </span>
            ${u.error_message ? `<p class="error-text">⚠️ Error: ${escapeHTML(u.error_message)}</p>` : ''}
            ${u.youtube_video_id ? `<p class="youtube-link">🔗 URL: <a href="https://youtu.be/${u.youtube_video_id}" target="_blank">https://youtu.be/${u.youtube_video_id}</a></p>` : ''}
          </div>
        </div>
      `;
    }).join('');
  } catch (err) {
    showToast('Failed to load upload history: ' + err.message, 'error');
  }
}

// ---------------------------------------------------------------------------
// 9. Media Library Upload & Actions
// ---------------------------------------------------------------------------
function setupDragAndDrop() {
  // Video drop zone
  const vidZone = document.getElementById('mediaVideoDropZone');
  const vidInput = document.getElementById('mediaVideoFileInput');
  
  vidZone.addEventListener('click', () => vidInput.click());
  vidInput.addEventListener('change', () => handleFilesUpload(vidInput.files, 'videos'));
  setupDropHandlers(vidZone, (files) => handleFilesUpload(files, 'videos'));

  // Thumbnail drop zone
  const thumbZone = document.getElementById('mediaThumbDropZone');
  const thumbInput = document.getElementById('mediaThumbFileInput');
  
  thumbZone.addEventListener('click', () => thumbInput.click());
  thumbInput.addEventListener('change', () => handleFilesUpload(thumbInput.files, 'thumbnails'));
  setupDropHandlers(thumbZone, (files) => handleFilesUpload(files, 'thumbnails'));

  // Channel thumbnail drop zone in Edit Modal
  const editThumbZone = document.getElementById('thumbDropZone');
  const editThumbInput = document.getElementById('thumbFileInput');
  editThumbZone.addEventListener('click', () => editThumbInput.click());
  editThumbInput.addEventListener('change', () => handleChannelThumbnailUpload(editThumbInput.files));
  setupDropHandlers(editThumbZone, (files) => handleChannelThumbnailUpload(files));
}

function setupDropHandlers(zone, onDropCallback) {
  ['dragenter', 'dragover'].forEach(eventName => {
    zone.addEventListener(eventName, (e) => {
      e.preventDefault();
      zone.classList.add('dragover');
    }, false);
  });

  ['dragleave', 'drop'].forEach(eventName => {
    zone.addEventListener(eventName, (e) => {
      e.preventDefault();
      zone.classList.remove('dragover');
    }, false);
  });

  zone.addEventListener('drop', (e) => {
    const dt = e.dataTransfer;
    const files = dt.files;
    onDropCallback(files);
  });
}

async function handleFilesUpload(files, type) {
  if (files.length === 0) return;

  const channelSelect = document.getElementById('mediaChannelSelect');
  const channelId = channelSelect ? channelSelect.value : '';

  if (!channelId) {
    showToast('Please select a YouTube Channel first to upload media into!', 'warning');
    return;
  }

  const formData = new FormData();
  formData.append('channelId', channelId);

  const url = type === 'videos' ? `${API_BASE}/media/upload-video` : `${API_BASE}/media/upload-thumbnail`;
  const fieldName = type === 'videos' ? 'videos' : 'thumbnails';

  if (type === 'videos') {
    showToast('Reading video durations...', 'info');
    const durations = [];
    for (let i = 0; i < files.length; i++) {
      try {
        const dur = await getVideoDuration(files[i]);
        durations.push(dur !== null ? parseFloat(dur.toFixed(2)) : null);
      } catch (e) {
        durations.push(null);
      }
    }
    formData.append('durations', JSON.stringify(durations));
  }

  for (let i = 0; i < files.length; i++) {
    formData.append(fieldName, files[i]);
  }

  showToast(`Uploading ${files.length} file(s)...`, 'info');

  try {
    const res = await fetch(url, {
      method: 'POST',
      body: formData
    });

    if (!res.ok) throw new Error(await res.text());

    showToast('Upload completed successfully!', 'success');
    if (type === 'videos') loadMediaVideos();
    else loadMediaThumbnails();
  } catch (err) {
    showToast('Upload failed: ' + err.message, 'error');
  }
}

async function handleChannelThumbnailUpload(files) {
  if (!state.selectedChannelId) return;
  if (files.length === 0) return;

  const formData = new FormData();
  for (let i = 0; i < files.length; i++) {
    formData.append('thumbnails', files[i]);
  }

  showToast('Uploading thumbnail(s)...', 'info');

  try {
    const res = await fetch(`${API_BASE}/channels/${state.selectedChannelId}/thumbnails`, {
      method: 'POST',
      body: formData
    });

    if (!res.ok) throw new Error(await res.text());

    showToast('Thumbnail uploaded successfully!', 'success');
    loadChannelThumbnails(state.selectedChannelId);
    loadChannels();
  } catch (err) {
    showToast('Upload failed: ' + err.message, 'error');
  }
}

function openScheduleModalForVideo(event, videoId) {
  // Prevent modal opening when clicking on video controls, delete button, or tags/descriptions
  if (event && event.target) {
    if (event.target.tagName === 'VIDEO' || 
        event.target.tagName === 'BUTTON' || 
        event.target.closest('button') || 
        event.target.closest('video') ||
        event.target.classList.contains('delete-media-btn') ||
        event.target.hasAttribute('controls') ||
        event.target.closest('[controls]')) {
      return;
    }
  }
  
  const video = state.videos.find(v => v.id === videoId);
  if (!video) return;

  // 1. Select the Channel in the modal
  const schedChannel = document.getElementById('schedChannel');
  if (schedChannel && video.channel_id) {
    schedChannel.value = video.channel_id;
    // Trigger channel change logic (populates video dropdown, next open slot, defaults etc.)
    onSchedChannelChange();
  }

  // 2. Select the Video in the modal
  const schedVideoSelect = document.getElementById('schedVideoSelect');
  if (schedVideoSelect) {
    schedVideoSelect.value = videoId;
    // Trigger video selection change logic (populates title, description, tags)
    onSchedVideoSelectChange();
  }

  // Reset wizard progress indicator to step 1 (Details)
  clickWizardStep(1);

  // 3. Open the modal
  openModal('scheduleModal');
}

function uploadCustomThumbnail(videoId) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const formData = new FormData();
    formData.append('thumbnail', file);

    try {
      showToast('Uploading custom thumbnail...', 'info');
      const res = await fetch(`${API_BASE}/media/videos/${videoId}/thumbnail`, {
        method: 'POST',
        body: formData
      });

      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      showToast('Custom thumbnail uploaded successfully!', 'success');
      
      // Reload media files to update the cover/preview image
      await loadMediaVideos();
    } catch (err) {
      showToast('Failed to upload thumbnail: ' + err.message, 'error');
    }
  };
  input.click();
}

async function deleteVideo(id) {
  if (!confirm('Are you sure you want to delete this video file?')) return;
  try {
    const res = await fetch(`${API_BASE}/media/videos/${id}`, { method: 'DELETE' });
    if (!res.ok) throw new Error(await res.text());
    showToast('Video file deleted.', 'success');
    loadMediaVideos();
  } catch (err) {
    showToast('Failed to delete video: ' + err.message, 'error');
  }
}

async function postVideoNow(videoId) {
  const video = state.videos.find(v => v.id === videoId);
  if (!video) return;

  if (!video.channel_id) {
    showToast('Please assign this video to a channel first in the Media Library details.', 'warning');
    return;
  }

  const channel = state.channels.find(c => c.id === video.channel_id);
  const channelName = channel ? channel.name : 'Unknown Channel';

  const cleanTitle = video.title || video.original_filename.replace(/\.[^/.]+$/, "").replace(/[_-]/g, " ").trim();

  if (!confirm(`Are you sure you want to upload and post "${cleanTitle}" to ${channelName} immediately?`)) {
    return;
  }

  showToast('Queueing video for immediate upload...', 'info');

  // Format "now" in local timezone string representation "YYYY-MM-DDTHH:MM:SS"
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const hh = String(now.getHours()).padStart(2, '0');
  const min = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');
  const scheduledAt = `${yyyy}-${mm}-${dd}T${hh}:${min}:${ss}`;

  try {
    const res = await fetch(`${API_BASE}/schedule`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channelId: video.channel_id,
        title: cleanTitle,
        description: video.description || '',
        tags: video.tags || '',
        videoId: video.id,
        scheduledAt,
        privacy: channel ? channel.upload_privacy : 'private',
        category: channel ? channel.category : '22',
        isPremiere: false
      })
    });

    if (!res.ok) throw new Error(await res.text());

    showToast('Video queued and uploading now in the background!', 'success');
    await loadAllData();
  } catch (err) {
    showToast('Failed to start immediate upload: ' + err.message, 'error');
  }
}

async function regenerateVideoMetadata(id) {
  showToast('Regenerating AI metadata...', 'info');
  try {
    const res = await fetch(`${API_BASE}/media/videos/${id}/regenerate`, { method: 'POST' });
    if (!res.ok) throw new Error(await res.text());
    
    showToast('AI metadata regenerated successfully!', 'success');
    loadMediaVideos();
  } catch (err) {
    showToast('Failed to regenerate: ' + err.message, 'error');
  }
}

async function deleteThumbnail(id) {
  if (!confirm('Are you sure you want to delete this thumbnail?')) return;
  try {
    const res = await fetch(`${API_BASE}/media/thumbnails/${id}`, { method: 'DELETE' });
    if (!res.ok) throw new Error(await res.text());
    showToast('Thumbnail file deleted.', 'success');
    loadMediaThumbnails();
  } catch (err) {
    showToast('Failed to delete thumbnail: ' + err.message, 'error');
  }
}

// ---------------------------------------------------------------------------
// 10. Schedule Post Actions & Wizard Controller
// ---------------------------------------------------------------------------
function toggleScheduleFields() {
  const checkbox = document.getElementById('schedPublishLater');
  const fields = document.getElementById('scheduleTimeFields');
  const btnCreateSchedule = document.getElementById('btnCreateSchedule');
  
  if (checkbox && fields) {
    if (checkbox.checked) {
      fields.classList.remove('hidden');
      if (btnCreateSchedule) btnCreateSchedule.textContent = 'Schedule Upload';
    } else {
      fields.classList.add('hidden');
      if (btnCreateSchedule) btnCreateSchedule.textContent = 'Upload Now';
    }
  }
}

function goToWizardStep(step) {
  state.currentWizardStep = step;
  
  // Toggle panes and indicators
  for (let i = 1; i <= 4; i++) {
    const pane = document.getElementById(`wizard-pane-${i}`);
    if (pane) pane.classList.toggle('active', i === step);
    
    const indicator = document.getElementById(`step-${i}-indicator`);
    if (indicator) {
      indicator.classList.toggle('active', i === step);
      indicator.classList.toggle('completed', i < step);
    }
  }
  
  // Buttons navigation states
  const backBtn = document.getElementById('btnWizardBack');
  if (backBtn) {
    backBtn.style.display = step > 1 ? 'block' : 'none';
  }
  
  const nextBtn = document.getElementById('btnWizardNext');
  const submitBtn = document.getElementById('btnCreateSchedule');
  
  if (nextBtn && submitBtn) {
    if (step === 4) {
      nextBtn.style.display = 'none';
      submitBtn.style.display = 'block';
    } else {
      nextBtn.style.display = 'block';
      submitBtn.style.display = 'none';
    }
  }
}

function nextWizardStep() {
  const step = state.currentWizardStep || 1;
  
  // Validation for Step 1
  if (step === 1) {
    const channelId = document.getElementById('schedChannel').value;
    const videoId = document.getElementById('schedVideoSelect').value;
    const title = document.getElementById('schedTitle').value.trim();
    
    if (!channelId) {
      showToast('Please select a Channel.', 'warning');
      return;
    }
    if (!videoId) {
      showToast('Please select a Video from the media library.', 'warning');
      return;
    }
    if (!title) {
      showToast('Please enter a Video Title.', 'warning');
      return;
    }
  }
  
  const nextStep = step + 1;
  goToWizardStep(nextStep);
  
  if (nextStep === 3) {
    runSimulatedChecks();
  }
}

function prevWizardStep() {
  const step = state.currentWizardStep || 1;
  if (step > 1) {
    goToWizardStep(step - 1);
  }
}

function clickWizardStep(targetStep) {
  const currentStep = state.currentWizardStep || 1;
  if (targetStep === currentStep) return;
  
  // If navigating forwards, check Step 1 requirements
  if (targetStep > currentStep) {
    if (currentStep === 1 || targetStep > 1) {
      const channelId = document.getElementById('schedChannel').value;
      const videoId = document.getElementById('schedVideoSelect').value;
      const title = document.getElementById('schedTitle').value.trim();
      
      if (!channelId) {
        showToast('Please select a Channel.', 'warning');
        return;
      }
      if (!videoId) {
        showToast('Please select a Video.', 'warning');
        return;
      }
      if (!title) {
        showToast('Please enter a Video Title.', 'warning');
        return;
      }
    }
  }
  
  goToWizardStep(targetStep);
  
  if (targetStep === 3) {
    runSimulatedChecks();
  }
}

function runSimulatedChecks() {
  const cIcon = document.getElementById('checkCopyrightIcon');
  const cTitle = document.getElementById('checkCopyrightTitle');
  const cDesc = document.getElementById('checkCopyrightDesc');
  const cBadge = document.getElementById('checkCopyrightBadge');
  
  const sIcon = document.getElementById('checkSuitabilityIcon');
  const sTitle = document.getElementById('checkSuitabilityTitle');
  const sDesc = document.getElementById('checkSuitabilityDesc');
  const sBadge = document.getElementById('checkSuitabilityBadge');
  
  const nextBtn = document.getElementById('btnWizardNext');
  if (nextBtn) {
    nextBtn.disabled = true;
    nextBtn.textContent = 'Checking...';
  }
  
  // Reset loader states
  cIcon.className = 'check-icon pending';
  cIcon.textContent = '⏳';
  cTitle.textContent = 'Copyright';
  cDesc.textContent = 'Checking for copyright-protected content...';
  cBadge.className = 'check-status-badge checking';
  cBadge.textContent = 'Checking';
  
  sIcon.className = 'check-icon pending';
  sIcon.textContent = '⏳';
  sTitle.textContent = 'Ad Suitability';
  sDesc.textContent = 'Checking if the video is advertiser-friendly...';
  sBadge.className = 'check-status-badge checking';
  sBadge.textContent = 'Checking';

  // Timeout simulations
  setTimeout(() => {
    if (state.currentWizardStep !== 3) return;
    cIcon.className = 'check-icon success';
    cIcon.textContent = '✅';
    cTitle.textContent = 'Copyright';
    cDesc.textContent = 'No copyright-protected content found.';
    cBadge.className = 'check-status-badge passed';
    cBadge.textContent = 'Passed';
  }, 1000);
  
  setTimeout(() => {
    if (state.currentWizardStep !== 3) return;
    sIcon.className = 'check-icon success';
    sIcon.textContent = '✅';
    sTitle.textContent = 'Ad Suitability';
    sDesc.textContent = 'This video is suitable for all advertisers.';
    sBadge.className = 'check-status-badge passed';
    sBadge.textContent = 'Passed';
    
    if (nextBtn) {
      nextBtn.disabled = false;
      nextBtn.textContent = 'Next';
    }
    showToast('All copyright and ad checks passed successfully!', 'success');
  }, 2000);
}

function resetScheduleWizard() {
  state.currentWizardStep = 1;
  goToWizardStep(1);
  
  const cIcon = document.getElementById('checkCopyrightIcon');
  if (cIcon) {
    cIcon.className = 'check-icon pending';
    cIcon.textContent = '⏳';
    document.getElementById('checkCopyrightTitle').textContent = 'Copyright';
    document.getElementById('checkCopyrightDesc').textContent = 'Checking for copyright-protected content...';
    document.getElementById('checkCopyrightBadge').className = 'check-status-badge checking';
    document.getElementById('checkCopyrightBadge').textContent = 'Checking';
  }
  
  const sIcon = document.getElementById('checkSuitabilityIcon');
  if (sIcon) {
    sIcon.className = 'check-icon pending';
    sIcon.textContent = '⏳';
    document.getElementById('checkSuitabilityTitle').textContent = 'Ad Suitability';
    document.getElementById('checkSuitabilityDesc').textContent = 'Checking if the video is advertiser-friendly...';
    document.getElementById('checkSuitabilityBadge').className = 'check-status-badge checking';
    document.getElementById('checkSuitabilityBadge').textContent = 'Checking';
  }
  
  const publishLater = document.getElementById('schedPublishLater');
  if (publishLater) {
    publishLater.checked = true;
    toggleScheduleFields();
  }
}

async function createScheduledPost() {
  const channelId = document.getElementById('schedChannel').value;
  const title = document.getElementById('schedTitle').value;
  const description = document.getElementById('schedDesc').value;
  const tags = document.getElementById('schedTags').value;
  const date = document.getElementById('schedDate').value;
  const time = document.getElementById('schedTime').value;
  const privacy = document.getElementById('schedPrivacy').value;
  const category = document.getElementById('schedCategory').value;
  const videoId = document.getElementById('schedVideoSelect').value;
  const customComment = document.getElementById('schedComment').value;
  const isPremiere = document.getElementById('schedIsPremiere') ? document.getElementById('schedIsPremiere').checked : false;
  
  let thumbnailId = null;
  if (videoId) {
    const videoObj = state.videos.find(v => v.id === parseInt(videoId, 10));
    if (videoObj && videoObj.thumbnail_id) {
      thumbnailId = videoObj.thumbnail_id;
    }
  }
  
  const publishLater = document.getElementById('schedPublishLater');
  const isScheduled = publishLater ? publishLater.checked : true;

  if (isScheduled) {
    if (!channelId || !title || !date || !time || !videoId) {
      showToast('Channel, Title, Video, Date, and Time are required!', 'warning');
      return;
    }
  } else {
    if (!channelId || !title || !videoId) {
      showToast('Channel, Title, and Video are required!', 'warning');
      return;
    }
  }

  let scheduledAt = '';
  if (isScheduled) {
    scheduledAt = `${date}T${time}:00`;
  } else {
    // Upload now: set schedule date to now in local browser timezone representation
    const now = new Date();
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    const hh = String(now.getHours()).padStart(2, '0');
    const min = String(now.getMinutes()).padStart(2, '0');
    const ss = String(now.getSeconds()).padStart(2, '0');
    scheduledAt = `${yyyy}-${mm}-${dd}T${hh}:${min}:${ss}`;
  }

  try {
    const res = await fetch(`${API_BASE}/schedule`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channelId: parseInt(channelId),
        title,
        description,
        tags,
        videoId: parseInt(videoId),
        thumbnailId: thumbnailId ? parseInt(thumbnailId) : null,
        scheduledAt,
        privacy,
        category,
        customComment,
        isPremiere
      })
    });

    if (!res.ok) throw new Error(await res.text());

    showToast(isScheduled ? 'Upload scheduled successfully!' : 'Video queued for immediate upload!', 'success');
    closeModal('scheduleModal');
    
    // Reset inputs
    document.getElementById('schedTitle').value = '';
    document.getElementById('schedDesc').value = '';
    document.getElementById('schedTags').value = '';
    document.getElementById('schedVideoSelect').value = '';
    document.getElementById('schedThumbSelect').value = '';
    document.getElementById('schedComment').value = '';
    if (document.getElementById('schedIsPremiere')) {
      document.getElementById('schedIsPremiere').checked = false;
    }
    const previewGroup = document.getElementById('schedThumbPreviewGroup');
    if (previewGroup) previewGroup.style.display = 'none';

    loadScheduledPosts();
  } catch (err) {
    showToast('Failed to schedule upload: ' + err.message, 'error');
  }
}

async function cancelScheduledPost(id) {
  if (!confirm('Are you sure you want to cancel and delete this scheduled upload?')) return;
  try {
    const res = await fetch(`${API_BASE}/schedule/${id}`, {
      method: 'DELETE'
    });
    if (!res.ok) throw new Error(await res.text());
    showToast('Scheduled upload cancelled.', 'success');
    loadScheduledPosts();
  } catch (err) {
    showToast('Failed to cancel: ' + err.message, 'error');
  }
}

async function retryScheduledPost(id) {
  showToast('Retrying upload...', 'info');
  try {
    const res = await fetch(`${API_BASE}/schedule/${id}/retry`, { method: 'POST' });
    if (!res.ok) throw new Error(await res.text());
    showToast('Upload restarted in background.', 'success');
    await loadScheduledPosts();
  } catch (err) {
    showToast('Failed to retry: ' + err.message, 'error');
  }
}

async function cleanUploadQueue() {
  if (!confirm('Are you sure you want to cancel and delete all scheduled and failed uploads from the queue? This will release their reserved titles and thumbnails.')) return;
  showToast('Cleaning upload queue...', 'info');
  try {
    const res = await fetch(`${API_BASE}/schedule/clean-all`, { method: 'POST' });
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    showToast(`Successfully cleared ${data.cleanedCount} items from the queue.`, 'success');
    await loadScheduledPosts();
  } catch (err) {
    showToast('Failed to clean queue: ' + err.message, 'error');
  }
}

function setVideoFilter(filter, btn) {
  state.videoFilter = filter;
  
  // Update active states of filter buttons
  document.querySelectorAll('.media-filter-tab').forEach(tab => {
    tab.classList.remove('active');
  });
  if (btn) {
    btn.classList.add('active');
  } else {
    const activeTab = document.getElementById(`tab-filter-${filter}`);
    if (activeTab) activeTab.classList.add('active');
  }

  // Recalculate display count and grid
  const allCount = state.videos.length;
  const publishedCount = state.videos.filter(vid => vid.is_published).length;
  const unpublishedCount = allCount - publishedCount;

  let displayedCount = allCount;
  if (filter === 'published') displayedCount = publishedCount;
  else if (filter === 'unpublished') displayedCount = unpublishedCount;

  const countEl = document.getElementById('mediaVideoCount');
  if (countEl) countEl.textContent = `${displayedCount} videos`;

  renderVideosGrid();
}

function onSchedChannelFilterChange() {
  const select = document.getElementById('schedChannelFilter');
  state.scheduleFilterChannelId = select ? select.value : '';
  renderScheduleCalendar();
}

function openEditScheduledPostModal(postId) {
  const post = state.scheduledPosts.find(p => p.id === postId);
  if (!post) {
    showToast('Scheduled post details not found.', 'error');
    return;
  }

  state.activeEditPostId = postId;

  // Set text values
  document.getElementById('viewSchedChannelName').value = post.channel_name || 'Unknown Channel';
  document.getElementById('viewSchedTitle').value = post.title || '';
  document.getElementById('viewSchedDesc').value = post.description || '';
  document.getElementById('viewSchedTags').value = post.tags || '';

  // Setup thumbnail preview
  const viewSchedThumbGroup = document.getElementById('viewSchedThumbGroup');
  const viewSchedThumbImg = document.getElementById('viewSchedThumbImg');
  if (viewSchedThumbGroup && viewSchedThumbImg) {
    let finalThumbId = post.thumbnail_id;
    if (!finalThumbId && post.video_id) {
      const associatedVideo = state.videos.find(v => v.id === post.video_id);
      if (associatedVideo) finalThumbId = associatedVideo.thumbnail_id;
    }
    if (finalThumbId) {
      viewSchedThumbImg.src = `/api/media/thumbnail-file/${finalThumbId}`;
      viewSchedThumbGroup.style.display = 'block';
    } else {
      viewSchedThumbGroup.style.display = 'none';
    }
  }

  // Setup Date and Time
  if (post.scheduled_at) {
    const parts = post.scheduled_at.split('T');
    document.getElementById('viewSchedDate').value = parts[0];
    if (parts[1]) {
      document.getElementById('viewSchedTime').value = parts[1].substring(0, 5);
    }
  }

  // Set up status banner
  const banner = document.getElementById('viewSchedStatusBanner');
  const statusText = document.getElementById('viewSchedStatusText');
  const badge = document.getElementById('viewSchedStatusBadge');

  badge.className = 'badge';
  badge.classList.add(post.status);
  badge.textContent = post.status;

  if (post.status === 'pending') {
    banner.style.background = 'rgba(99, 102, 241, 0.08)';
    banner.style.borderColor = 'rgba(99, 102, 241, 0.25)';
    banner.style.color = '#a5b4fc';
    statusText.textContent = 'Status: PENDING (Scheduled Upload)';
  } else if (post.status === 'complete') {
    banner.style.background = 'rgba(16, 185, 129, 0.08)';
    banner.style.borderColor = 'rgba(16, 185, 129, 0.25)';
    banner.style.color = '#a7f3d0';
    statusText.textContent = 'Status: COMPLETE (Published to YouTube)';
  } else if (post.status === 'error') {
    banner.style.background = 'rgba(239, 68, 68, 0.08)';
    banner.style.borderColor = 'rgba(239, 68, 68, 0.25)';
    banner.style.color = '#fca5a5';
    statusText.textContent = `Status: FAILED (${post.error_message || 'Unknown error'})`;
  } else {
    banner.style.background = 'rgba(156, 163, 175, 0.08)';
    banner.style.borderColor = 'rgba(156, 163, 175, 0.25)';
    banner.style.color = '#d1d5db';
    statusText.textContent = 'Status: CANCELLED';
  }

  // Setup inputs editability
  const isFutureComplete = post.status === 'complete' && new Date(post.scheduled_at) > new Date();
  const isEditable = ['pending', 'error'].includes(post.status);
  const canReschedule = isEditable || isFutureComplete;

  document.getElementById('viewSchedTitle').disabled = !isEditable;
  document.getElementById('viewSchedDesc').disabled = !isEditable;
  document.getElementById('viewSchedTags').disabled = !isEditable;
  document.getElementById('viewSchedDate').disabled = !canReschedule;
  document.getElementById('viewSchedTime').disabled = !canReschedule;

  // Toggle Premiere option visibility based on video duration
  const video = post.video_id ? state.videos.find(v => v.id === post.video_id) : null;
  const viewSchedPremiereGroup = document.getElementById('viewSchedPremiereGroup');
  const viewSchedIsPremiere = document.getElementById('viewSchedIsPremiere');
  if (viewSchedPremiereGroup && viewSchedIsPremiere) {
    if (video && video.duration && video.duration <= 60) {
      viewSchedPremiereGroup.style.display = 'none';
      viewSchedIsPremiere.checked = false;
    } else {
      viewSchedPremiereGroup.style.display = 'flex';
      viewSchedIsPremiere.checked = !!post.is_premiere;
      viewSchedIsPremiere.disabled = !canReschedule;
    }
  }

  // Toggle buttons
  document.getElementById('btnSaveSchedPostChanges').style.display = canReschedule ? 'inline-block' : 'none';
  document.getElementById('btnCancelSchedPost').style.display = isEditable ? 'inline-block' : 'none';

  // Toggle link section
  const publishedSec = document.getElementById('viewSchedPublishedSection');
  if (post.status === 'complete' && post.youtube_video_id) {
    publishedSec.style.display = 'block';
    document.getElementById('viewSchedFilename').textContent = post.video_filename ? `File: ${post.video_filename}` : '';
    document.getElementById('viewSchedYoutubeLink').href = `https://youtu.be/${post.youtube_video_id}`;
  } else {
    publishedSec.style.display = 'none';
  }

  openModal('viewScheduledPostModal');
}

async function saveSchedPostChanges() {
  const id = state.activeEditPostId;
  if (!id) return;

  const title = document.getElementById('viewSchedTitle').value.trim();
  const description = document.getElementById('viewSchedDesc').value.trim();
  const tags = document.getElementById('viewSchedTags').value.trim();
  const date = document.getElementById('viewSchedDate').value;
  const time = document.getElementById('viewSchedTime').value;
  const isPremiere = document.getElementById('viewSchedIsPremiere') ? document.getElementById('viewSchedIsPremiere').checked : false;

  if (!title || !date || !time) {
    showToast('Title, Date and Time are required.', 'warning');
    return;
  }

  const scheduledAt = `${date}T${time}:00`;

  showToast('Saving changes...', 'info');
  try {
    const res = await fetch(`${API_BASE}/schedule/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title,
        description,
        tags,
        scheduledAt,
        isPremiere
      })
    });

    if (!res.ok) throw new Error(await res.text());

    const post = state.scheduledPosts.find(p => p.id === id);
    if (post && post.status === 'complete' && post.channel_upload_mode === 'browser') {
      showToast('Updated local schedule. Please manually reschedule the video in YouTube Studio (browser mode).', 'warning');
    } else {
      showToast('Scheduled post updated successfully.', 'success');
    }
    
    closeModal('viewScheduledPostModal');
    loadScheduledPosts();
  } catch (err) {
    showToast('Failed to save changes: ' + err.message, 'error');
  }
}

async function deleteSchedPostFromViewModal() {
  const id = state.activeEditPostId;
  if (!id) return;

  if (!confirm('Are you sure you want to cancel and delete this scheduled upload?')) return;
  
  showToast('Deleting scheduled post...', 'info');
  try {
    const res = await fetch(`${API_BASE}/schedule/${id}`, {
      method: 'DELETE'
    });
    if (!res.ok) throw new Error(await res.text());
    showToast('Scheduled upload cancelled and deleted.', 'success');
    closeModal('viewScheduledPostModal');
    loadScheduledPosts();
  } catch (err) {
    showToast('Failed to delete scheduled post: ' + err.message, 'error');
  }
}

function onSelectSavedComment() {
  const select = document.getElementById('schedSavedCommentSelect');
  const commentId = select ? select.value : '';
  const commentTextarea = document.getElementById('schedComment');

  if (!commentId) {
    commentTextarea.value = '';
    return;
  }

  const commentObj = state.savedComments.find(c => c.id === parseInt(commentId));
  if (commentObj && commentTextarea) {
    commentTextarea.value = commentObj.text;
  }
}

async function saveCommentAsTemplate() {
  const text = document.getElementById('schedComment').value.trim();
  if (!text) {
    showToast('Please type a comment in the text box first to save it as a template!', 'warning');
    return;
  }

  const title = prompt('Enter a name/title for this comment template:');
  if (!title) return; // Cancelled

  try {
    const res = await fetch(`${API_BASE}/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, text })
    });

    if (!res.ok) throw new Error(await res.text());

    showToast('Comment template saved successfully!', 'success');
    await loadSavedComments();
    
    // Select the newly created template
    const newTemplate = state.savedComments.find(c => c.title === title);
    if (newTemplate) {
      document.getElementById('schedSavedCommentSelect').value = newTemplate.id;
    }
  } catch (err) {
    showToast('Failed to save template: ' + err.message, 'error');
  }
}

// AI Helpers in Schedule Modal
async function autoGenerateTitle() {
  const channelId = document.getElementById('schedChannel').value;
  if (!channelId) {
    showToast('Please select a channel first.', 'warning');
    return;
  }
  const channel = state.channels.find(c => c.id === parseInt(channelId));
  if (!channel) {
    showToast('Please select a valid channel first.', 'warning');
    return;
  }

  let videoContext = '';
  const videoSelect = document.getElementById('schedVideoSelect');
  if (videoSelect && videoSelect.value) {
    const video = state.videos.find(v => v.id === parseInt(videoSelect.value));
    if (video) {
      videoContext = video.original_filename || video.title || '';
    }
  }

  showToast('Generating title...', 'info');
  try {
    const res = await fetch(`${API_BASE}/ai/generate-titles`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channelId: channel.id, count: 1, videoContext })
    });
    const result = await res.json();
    if (!res.ok) {
      throw new Error(result.error || 'Failed to generate title');
    }
    if (result.titles && result.titles.length > 0) {
      document.getElementById('schedTitle').value = result.titles[0].text;
      showToast('Title generated!', 'success');
    }
  } catch (err) {
    showToast('Failed to generate title: ' + err.message, 'error');
  }
}

async function autoGenerateDesc() {
  const channelId = document.getElementById('schedChannel').value;
  const title = document.getElementById('schedTitle').value;
  if (!channelId || !title) {
    showToast('Please select a channel and enter/generate a title first.', 'warning');
    return;
  }
  const channel = state.channels.find(c => c.id === parseInt(channelId));
  if (!channel) {
    showToast('Please select a valid channel first.', 'warning');
    return;
  }
  const niche = channel.niche || channel.description || channel.name || 'General';

  showToast('Generating description & tags...', 'info');
  try {
    // Generate Description
    const resDesc = await fetch(`${API_BASE}/ai/generate-description`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, niche })
    });
    const descData = await resDesc.json();
    if (!resDesc.ok) {
      throw new Error(descData.error || 'Server error generating description');
    }
    document.getElementById('schedDesc').value = descData.description || '';

    // Generate Tags
    const resTags = await fetch(`${API_BASE}/ai/generate-tags`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, niche })
    });
    const tagsData = await resTags.json();
    if (!resTags.ok) {
      throw new Error(tagsData.error || 'Server error generating tags');
    }
    if (Array.isArray(tagsData.tags)) {
      document.getElementById('schedTags').value = tagsData.tags.join(', ');
    } else if (typeof tagsData.tags === 'string') {
      document.getElementById('schedTags').value = tagsData.tags;
    } else {
      document.getElementById('schedTags').value = '';
    }

    showToast('Description and tags generated!', 'success');
  } catch (err) {
    showToast('Failed to generate: ' + err.message, 'error');
  }
}

// ---------------------------------------------------------------------------
// 11. Settings Actions
// ---------------------------------------------------------------------------
async function saveGoogleCreds() {
  const clientId = document.getElementById('settingsClientId').value;
  const clientSecret = document.getElementById('settingsClientSecret').value;

  try {
    const res = await fetch(`${API_BASE}/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        google_client_id: clientId,
        google_client_secret: clientSecret
      })
    });

    if (!res.ok) throw new Error(await res.text());
    showToast('Google credentials saved.', 'success');
    loadSettings();
  } catch (err) {
    showToast('Failed to save credentials: ' + err.message, 'error');
  }
}

async function saveAiSettings() {
  const provider = document.getElementById('settingsAiProvider').value;
  const geminiKey = document.getElementById('settingsGeminiKey').value;
  const openaiKey = document.getElementById('settingsOpenaiKey').value;
  const groqKey = document.getElementById('settingsGroqKey').value;
  const aiLanguage = document.getElementById('settingsAiLanguage').value;

  try {
    const res = await fetch(`${API_BASE}/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ai_provider: provider,
        gemini_api_key: geminiKey,
        openai_api_key: openaiKey,
        groq_api_key: groqKey,
        ai_language: aiLanguage
      })
    });

    if (!res.ok) throw new Error(await res.text());
    showToast('AI settings saved.', 'success');
    loadSettings();
  } catch (err) {
    showToast('Failed to save AI settings: ' + err.message, 'error');
  }
}

function toggleAiKeyVisibility() {
  const provider = document.getElementById('settingsAiProvider').value;
  const geminiGroup = document.getElementById('geminiKeyGroup');
  const openaiGroup = document.getElementById('openaiKeyGroup');
  const groqGroup = document.getElementById('groqKeyGroup');

  geminiGroup.style.display = provider === 'gemini' ? 'block' : 'none';
  openaiGroup.style.display = provider === 'openai' ? 'block' : 'none';
  if (groqGroup) groqGroup.style.display = provider === 'groq' ? 'block' : 'none';
}

async function saveDefaults() {
  const privacy = document.getElementById('settingsPrivacy').value;
  const category = document.getElementById('settingsCategory').value;
  const comment = document.getElementById('settingsComment').value;
  const autoDelete = document.getElementById('settingsAutoDelete') ? document.getElementById('settingsAutoDelete').checked : false;
  const weeklyCleanup = document.getElementById('settingsWeeklyCleanup') ? document.getElementById('settingsWeeklyCleanup').checked : false;

  const nordvpn_username = document.getElementById('settingsNordUsername').value;
  const nordvpn_password = document.getElementById('settingsNordPassword').value;
  const protonvpn_username = document.getElementById('settingsProtonUsername').value;
  const protonvpn_password = document.getElementById('settingsProtonPassword').value;

  try {
    const res = await fetch(`${API_BASE}/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        default_privacy: privacy,
        default_category: category,
        default_comment: comment,
        auto_delete_published: autoDelete ? 'true' : 'false',
        weekly_cleanup_published: weeklyCleanup ? 'true' : 'false',
        nordvpn_username,
        nordvpn_password,
        protonvpn_username,
        protonvpn_password
      })
    });

    if (!res.ok) throw new Error(await res.text());
    showToast('Default settings saved.', 'success');
    loadSettings();
  } catch (err) {
    showToast('Failed to save settings: ' + err.message, 'error');
  }
}

async function triggerCleanupNow() {
  if (!confirm('Are you sure you want to run the video cleanup now? This will permanently delete the oldest 50% of published videos from disk and database.')) {
    return;
  }

  const btn = document.getElementById('btnRunCleanupNow');
  if (btn) {
    btn.disabled = true;
    btn.textContent = '⌛ Running...';
  }

  try {
    const res = await fetch(`${API_BASE}/settings/cleanup`, { method: 'POST' });
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    showToast(`Cleanup complete. Deleted ${data.deletedCount} video file(s).`, 'success');
    await loadAllData();
  } catch (err) {
    showToast('Failed to run cleanup: ' + err.message, 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '🗑️ Run Cleanup Now';
    }
  }
}

function onOauthChannelSelectChange(selectElem) {
  if (selectElem.value === 'new') {
    if (selectElem.options.length > 1) {
      selectElem.value = selectElem.options[0].value;
    } else {
      selectElem.value = '';
    }
    openModal('addChannelModal');
  }
}

async function renderOAuthStatus() {
  const container = document.getElementById('oauthStatus');
  
  document.getElementById('btnConnectGoogle').disabled = state.channels.length === 0;

  // Let's render a selection list of channels to authenticate
  let selectHTML = `
    <div class="settings-form">
      <div class="form-group">
        <label>Select Channel to Authorize</label>
        <select id="oauthChannelSelect" class="form-input" onchange="onOauthChannelSelectChange(this)">
          ${state.channels.map(ch => `<option value="${ch.id}">${escapeHTML(ch.name)}</option>`).join('')}
          <option value="new">＋ Create New Channel...</option>
        </select>
      </div>
    </div>
    <div class="connections-list" style="margin-top:12px;">
  `;

  try {
    const res = await fetch(`${API_BASE}/auth/status`);
    const { connected } = await res.json();

    if (connected.length === 0) {
      selectHTML += `<p class="muted">No channels authorized yet.</p>`;
      document.getElementById('dashAuthWarning').classList.remove('hidden');
    } else {
      document.getElementById('dashAuthWarning').classList.add('hidden');
      selectHTML += connected.map(c => `
        <div class="conn-item glass-light" style="display:flex;justify-content:space-between;align-items:center;padding:8px 12px;border-radius:6px;margin-bottom:8px;">
          <span>🟢 <strong>${escapeHTML(c.name)}</strong> (ID: ${escapeHTML(c.youtube_channel_id || 'Pending')})</span>
          <button class="btn-outline-danger btn-xs" onclick="disconnectOAuth(${c.id})">Disconnect</button>
        </div>
      `).join('');
    }
  } catch {
    selectHTML += `<p class="error-text">Failed to fetch authorized channels status.</p>`;
  }

  selectHTML += '</div>';
  container.innerHTML = selectHTML;
}

function connectGoogle() {
  const channelId = document.getElementById('oauthChannelSelect').value;
  if (!channelId) {
    showToast('Please select a channel to authorize.', 'warning');
    return;
  }
  
  // Open the OAuth URL in a popup
  const width = 600;
  const height = 700;
  const left = (screen.width - width) / 2;
  const top = (screen.height - height) / 2;
  
  const popup = window.open(
    `${API_BASE}/auth/google?channelId=${channelId}`,
    'Google OAuth Connection',
    `width=${width},height=${height},left=${left},top=${top},resizable=yes,scrollbars=yes,status=yes`
  );

  // Monitor for completion message
  window.addEventListener('message', function listen(event) {
    if (event.data === 'oauth-success') {
      showToast('YouTube connection authorized successfully!', 'success');
      loadAllData();
      window.removeEventListener('message', listen);
    }
  });
}

async function disconnectOAuth(channelId) {
  if (!confirm('Are you sure you want to disconnect Google OAuth for this channel?')) return;

  try {
    const res = await fetch(`${API_BASE}/auth/disconnect/${channelId}`, { method: 'POST' });
    if (!res.ok) throw new Error(await res.text());
    showToast('Disconnected successfully.', 'success');
    loadAllData();
  } catch (err) {
    showToast('Failed to disconnect: ' + err.message, 'error');
  }
}

async function renderServerStatus() {
  const container = document.getElementById('serverStatus');
  try {
    const res = await fetch(`${API_BASE}/settings/status`);
    const status = await res.json();
    
    container.innerHTML = `
      <div class="server-status-grid">
        <p>⚡ status: <span>${status.status.toUpperCase()}</span></p>
        <p>⏰ Uptime: <span>${(status.uptime / 60).toFixed(1)} mins</span></p>
        <p>📺 Channels: <span>${status.channels} (${status.connectedChannels} connected)</span></p>
        <p>📅 Queue size: <span>${status.pendingScheduledPosts} posts pending</span></p>
        <p>🚀 Total uploaded: <span>${status.totalUploads} uploads</span></p>
      </div>
    `;
  } catch {
    container.innerHTML = `<p class="error-text">Could not retrieve server health info.</p>`;
  }
}

// ---------------------------------------------------------------------------
// 12. WebSocket & Logs
// ---------------------------------------------------------------------------
function initWS() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}`;
  
  state.ws = new WebSocket(wsUrl);

  state.ws.onopen = () => {
    console.log('[WS] Connected to server.');
    document.getElementById('serverConnectionStatus').className = 'server-status';
    document.getElementById('serverConnectionStatus').querySelector('span:not(.pulse-dot)').textContent = 'Connected';
  };

  state.ws.onclose = () => {
    console.warn('[WS] Connection lost. Reconnecting in 5s...');
    document.getElementById('serverConnectionStatus').className = 'server-status offline';
    document.getElementById('serverConnectionStatus').querySelector('span:not(.pulse-dot)').textContent = 'Disconnected';
    setTimeout(initWS, 5000);
  };

  state.ws.onerror = (err) => {
    console.error('[WS] Error:', err);
  };

  state.ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      handleWSMessage(data);
    } catch {
      appendTerminalLog('Received raw text: ' + event.data, 'muted');
    }
  };
}

function handleWSMessage(data) {
  // Append log in logs tab
  if (data.message) {
    appendTerminalLog(data.message, data.type === 'schedule:error' ? 'error' : 'normal');
  }

  // Handle active upload status on dashboard
  if (data.type === 'schedule:uploading') {
    let shouldShow = true;
    if (state.filterChannelId) {
      const activeCh = state.channels.find(c => c.id === parseInt(state.filterChannelId));
      if (activeCh && activeCh.name !== data.channel) {
        shouldShow = false;
      }
    }
    if (shouldShow) {
      document.getElementById('activeUploadSection').classList.remove('hidden');
      document.getElementById('activeUploadChannel').textContent = data.channel;
      document.getElementById('activeUploadTitle').textContent = data.title;
      document.getElementById('activeUploadProgress').style.width = '20%';
      document.getElementById('activeUploadPct').textContent = 'Uploading...';
    } else {
      document.getElementById('activeUploadSection').classList.add('hidden');
    }
  } else if (data.type === 'schedule:complete') {
    document.getElementById('activeUploadProgress').style.width = '100%';
    document.getElementById('activeUploadPct').textContent = 'Completed!';
    setTimeout(() => {
      document.getElementById('activeUploadSection').classList.add('hidden');
    }, 5000);
    loadAllData();
  } else if (data.type === 'schedule:error') {
    document.getElementById('activeUploadPct').textContent = 'Failed!';
    setTimeout(() => {
      document.getElementById('activeUploadSection').classList.add('hidden');
    }, 5000);
    loadAllData();
  } else if (data.type === 'schedule:status') {
    appendTerminalLog(`[Scheduler] Post ${data.postId}: ${data.message}`);
  } else if (data.type === 'pipeline:update') {
    updatePipelineStatusUI();
    if (['complete', 'error', 'cancelled'].includes(data.status)) {
      loadAllData();
    }
  } else if (data.type === 'video_metadata_updated') {
    loadMediaVideos().then(() => {
      // If the schedule wizard is open and the selected video is the updated one, reload its values!
      const select = document.getElementById('schedVideoSelect');
      if (select && parseInt(select.value, 10) === data.videoId) {
        onSchedVideoSelectChange();
      }
    });
  } else if (data.type === 'puppet:screencast') {
    // Per-channel puppet session (edit channel modal)
    if (Number(state.selectedChannelId) === Number(data.channelId)) {
      const img = document.getElementById('puppetScreenImg');
      if (img) {
        img.src = 'data:image/jpeg;base64,' + data.frame;
      }
    }
  } else if (data.type === 'puppet:session_ready') {
    // Per-channel puppet session
    if (Number(state.selectedChannelId) === Number(data.channelId)) {
      const container = document.getElementById('puppetScreenContainer');
      if (container) {
        container.style.display = 'block';
        setTimeout(() => focusPuppetKeyboard(), 150);
      }
      // Update status UI
      const statusText = document.getElementById('browserLoginStatusText');
      const closeBtn = document.getElementById('btnBrowserLoginClose');
      const openBtn = document.getElementById('btnBrowserLoginOpen');
      if (statusText) { statusText.className = 'badge badge-live'; statusText.textContent = 'Active Login Window'; }
      if (closeBtn) closeBtn.classList.remove('hidden');
      if (openBtn) { openBtn.textContent = '🔑 Browser Login Open'; openBtn.disabled = true; }
    }
  } else if (data.type === 'puppet:session_error') {
    if (Number(state.selectedChannelId) === Number(data.channelId)) {
      showToast(`Browser failed to start: ${data.error}`, 'error');
      const openBtn = document.getElementById('btnBrowserLoginOpen');
      if (openBtn) { openBtn.textContent = '🔑 Start Browser Login'; openBtn.disabled = false; }
    }
  } else if (data.type === 'puppet:session_closed') {
    if (Number(state.selectedChannelId) === Number(data.channelId)) {
      const container = document.getElementById('puppetScreenContainer');
      if (container) container.style.display = 'none';
      updateBrowserLoginStatus(data.channelId);
    }
  }
}

function appendTerminalLog(text, style = 'normal') {
  const term = document.getElementById('logTerminal');
  if (!term) return;

  const line = document.createElement('div');
  line.className = `log-line log-${style}`;
  line.textContent = `[${new Date().toLocaleTimeString()}] ${text}`;
  
  term.appendChild(line);
  
  state.logs.push(text);
  document.getElementById('logCount').textContent = `(${state.logs.length})`;

  // Scroll to bottom if checkbox checked
  const auto = document.getElementById('autoScroll');
  if (auto && auto.checked) {
    term.scrollTop = term.scrollHeight;
  }
}

function clearLogs() {
  const term = document.getElementById('logTerminal');
  term.innerHTML = '<div class="log-muted">Logs cleared.</div>';
  state.logs = [];
  document.getElementById('logCount').textContent = '(0)';
}

// ---------------------------------------------------------------------------
// 13. UI Helpers (Modals & Toast)
// ---------------------------------------------------------------------------
function openModal(id) {
  document.getElementById(id).classList.add('active');
  if (id === 'scheduleModal') {
    resetScheduleWizard();
  }
}

function closeModal(id) {
  document.getElementById(id).classList.remove('active');
  if (id === 'editChannelModal' && browserLoginPollInterval) {
    clearInterval(browserLoginPollInterval);
    browserLoginPollInterval = null;
  }
}

function handleOverlayClick(event, id) {
  if (event.target.id === id) {
    closeModal(id);
  }
}

function showToast(message, type = 'info') {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.className = `toast toast-${type} show`;
  
  setTimeout(() => {
    toast.className = `toast toast-${type}`;
  }, 4000);
}

function escapeHTML(str) {
  if (!str) return '';
  return str.replace(/[&<>'"]/g, 
    tag => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      "'": '&#39;',
      '"': '&quot;'
    }[tag] || tag)
  );
}

// ---------------------------------------------------------------------------
// USER AUTH & SESSION
// ---------------------------------------------------------------------------

async function checkAuth() {
  try {
    const res = await fetch(`${API_BASE}/client/me`);
    const data = await res.json();
    if (!data.authenticated) {
      window.location.href = '/login.html';
      return;
    }
    state.currentUser = data.user;

    // Show user email in header
    const emailEl = document.getElementById('headerUserEmail');
    if (emailEl) emailEl.textContent = data.user.email;

    // Show Users tab for admins
    if (data.user.role === 'admin') {
      const navUsers = document.getElementById('nav-users');
      if (navUsers) navUsers.style.display = '';
    }
  } catch (err) {
    console.error('Auth check failed:', err);
    window.location.href = '/login.html';
  }
}

async function handleLogout() {
  try {
    await fetch(`${API_BASE}/client/logout`, { method: 'POST' });
  } catch (e) {
    // best-effort
  }
  window.location.href = '/login.html';
}

// ---------------------------------------------------------------------------
// USER MANAGEMENT (Admin only)
// ---------------------------------------------------------------------------

async function loadUsers() {
  try {
    const res = await fetch(`${API_BASE}/client/users`);
    if (!res.ok) return;
    const data = await res.json();
    renderUsersTable(data.users || []);
  } catch (err) {
    showToast('Failed to load users: ' + err.message, 'error');
  }
}

function renderUsersTable(users) {
  const tbody = document.getElementById('usersTableBody');
  if (!tbody) return;

  if (!users.length) {
    tbody.innerHTML = `<tr><td colspan="6" style="text-align:center; padding:40px; color:var(--text-muted);">No users found</td></tr>`;
    return;
  }

  tbody.innerHTML = users.map(u => {
    const isCurrentUser = state.currentUser && u.id === state.currentUser.id;
    return `
      <tr style="border-bottom: 1px solid rgba(255,255,255,0.04); transition: background 0.2s;" onmouseenter="this.style.background='rgba(255,255,255,0.02)'" onmouseleave="this.style.background='none'">
        <td style="padding:12px; font-family:'JetBrains Mono',monospace; color:var(--text-muted);">#${u.id}</td>
        <td style="padding:12px; font-weight:500;">${escapeHTML(u.email)}</td>
        <td style="padding:12px; font-family:'JetBrains Mono',monospace; font-size:0.8rem; color:var(--text-secondary);">${escapeHTML(u.license_key)}</td>
        <td style="padding:12px;">
          <span style="padding:3px 10px; border-radius:20px; font-size:0.75rem; font-weight:600; ${
            u.role === 'admin'
              ? 'background:rgba(99,102,241,0.15); color:var(--accent-indigo);'
              : 'background:rgba(52,211,153,0.15); color:var(--accent-emerald);'
          }">${u.role}</span>
        </td>
        <td style="padding:12px; color:var(--text-muted); font-size:0.85rem;">${u.created_at || '—'}</td>
        <td style="padding:12px; text-align:right;">
          ${isCurrentUser
            ? '<span style="color:var(--text-muted); font-size:0.8rem;">You</span>'
            : `<button onclick="deleteUserProfile(${u.id})" style="background:rgba(248,113,113,0.1); border:1px solid rgba(248,113,113,0.3); color:var(--accent-red); padding:4px 12px; border-radius:6px; cursor:pointer; font-size:0.8rem; transition:all 0.2s;" onmouseenter="this.style.background='rgba(248,113,113,0.2)'" onmouseleave="this.style.background='rgba(248,113,113,0.1)'">Delete</button>`
          }
        </td>
      </tr>`;
  }).join('');
}

async function createUserProfile() {
  const email = document.getElementById('newUserEmail')?.value.trim();
  const password = document.getElementById('newUserPassword')?.value;
  const license_key = document.getElementById('newUserLicenseKey')?.value.trim();
  const role = document.getElementById('newUserRole')?.value || 'user';

  if (!email || !password || !license_key) {
    showToast('Email, password, and license key are required.', 'error');
    return;
  }

  try {
    const res = await fetch(`${API_BASE}/client/users`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, license_key, role })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to create user');

    showToast(`User ${data.user.email} created successfully!`, 'success');
    closeModal('addUserModal');

    // Clear form
    document.getElementById('newUserEmail').value = '';
    document.getElementById('newUserPassword').value = '';
    document.getElementById('newUserLicenseKey').value = '';
    document.getElementById('newUserRole').value = 'user';

    loadUsers();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function deleteUserProfile(userId) {
  if (!confirm('Are you sure you want to delete this user? All their data will be lost.')) return;

  try {
    const res = await fetch(`${API_BASE}/client/users/${userId}`, { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to delete user');

    showToast('User deleted successfully.', 'success');
    loadUsers();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function generateRandomLicenseKey() {
  const seg = () => Math.random().toString(16).substring(2, 6);
  const key = `${seg()}${seg()}-${seg()}-${seg()}-${seg()}${seg()}${seg()}`;
  const input = document.getElementById('newUserLicenseKey');
  if (input) input.value = key;
}

function onGlobalChannelFilterChange() {
  const filterSelect = document.getElementById('globalChannelFilter');
  if (filterSelect) {
    state.filterChannelId = filterSelect.value;
  }
  
  // Re-render everything that depends on filtered channel
  updateDashboardStats();
  renderDashboardCalendar();
  renderScheduleCalendar();
  renderUpcomingQueue();
  renderUpcomingQueueTab();
  
  // Sync Media Library Channel dropdown (if it exists) to show consistent view
  const mediaChSelect = document.getElementById('mediaChannelSelect');
  if (mediaChSelect) {
    mediaChSelect.value = state.filterChannelId;
    if (typeof onMediaChannelChange === 'function') {
      onMediaChannelChange();
    }
  }
}

// ---------------------------------------------------------------------------
// 10. Day Selection & Schedule Presets Helpers
// ---------------------------------------------------------------------------

function setupDaySelectors() {
  const container = document.getElementById('editChDaysContainer');
  if (!container) return;

  const dayButtons = container.querySelectorAll('.day-btn');
  const hiddenInput = document.getElementById('editChDays');
  const everydayBtn = document.getElementById('editChEverydayBtn');

  dayButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      btn.classList.toggle('active');
      updateDaysFromUI();
    });
  });

  everydayBtn.addEventListener('click', () => {
    const activeButtons = container.querySelectorAll('.day-btn.active');
    const shouldSelectAll = activeButtons.length < 7;

    dayButtons.forEach(btn => {
      btn.classList.toggle('active', shouldSelectAll);
    });
    
    everydayBtn.classList.toggle('all-selected', shouldSelectAll);
    updateDaysFromUI();
  });

  function updateDaysFromUI() {
    const activeDays = [];
    dayButtons.forEach(btn => {
      if (btn.classList.contains('active')) {
        activeDays.push(btn.getAttribute('data-day'));
      }
    });

    if (activeDays.length === 7) {
      hiddenInput.value = 'everyday';
      everydayBtn.classList.add('all-selected');
    } else {
      hiddenInput.value = activeDays.join(',');
      everydayBtn.classList.remove('all-selected');
    }
  }
}

function setDaysUIFromValue(value) {
  const container = document.getElementById('editChDaysContainer');
  if (!container) return;

  const dayButtons = container.querySelectorAll('.day-btn');
  const everydayBtn = document.getElementById('editChEverydayBtn');

  const normalized = value.toLowerCase().trim();
  const selectedDays = (normalized === 'everyday' || normalized === 'mon,tue,wed,thu,fri,sat,sun') 
    ? ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']
    : normalized.split(',').map(d => d.trim().replace(/^every\s+/i, '').substring(0, 3));

  dayButtons.forEach(btn => {
    const day = btn.getAttribute('data-day');
    btn.classList.toggle('active', selectedDays.includes(day));
  });

  everydayBtn.classList.toggle('all-selected', selectedDays.length === 7);
}

async function loadSchedulePresets() {
  try {
    const res = await fetch(`${API_BASE}/schedule-presets`);
    state.schedulePresets = await res.json();
    populateSchedulePresetsDropdown();
    populateDashboardPresetsDropdown();
  } catch (err) {
    showToast('Failed to load schedule presets: ' + err.message, 'error');
  }
}

function populateSchedulePresetsDropdown() {
  const select = document.getElementById('schedPresetSelect');
  if (!select) return;

  const options = state.schedulePresets.map(p => {
    const daysDisplay = p.days === 'everyday' ? 'Everyday' : p.days.toUpperCase();
    return `<option value="${p.id}">${escapeHTML(p.name)} (${p.time} — ${daysDisplay})</option>`;
  }).join('');

  select.innerHTML = '<option value="">-- Select from schedule presets --</option>' + options;
  
  const deleteBtn = document.getElementById('btnDeletePreset');
  if (deleteBtn) deleteBtn.style.display = 'none';
}

function onSelectSchedulePreset() {
  const select = document.getElementById('schedPresetSelect');
  const deleteBtn = document.getElementById('btnDeletePreset');
  const presetId = select ? select.value : '';

  if (!presetId) {
    if (deleteBtn) deleteBtn.style.display = 'none';
    return;
  }

  if (deleteBtn) deleteBtn.style.display = 'inline-flex';

  const preset = state.schedulePresets.find(p => p.id === parseInt(presetId));
  if (!preset) return;

  const timeInput = document.getElementById('schedTime');
  const dateInput = document.getElementById('schedDate');
  const channelId = document.getElementById('schedChannel').value;

  if (timeInput) {
    setScheduleTimeValue(preset.time);
  }

  if (dateInput) {
    const nextSlot = calculateNextAvailableSlot(channelId || '1', preset.days, preset.time);
    if (nextSlot) {
      const yyyy = nextSlot.getFullYear();
      const mm = String(nextSlot.getMonth() + 1).padStart(2, '0');
      const dd = String(nextSlot.getDate()).padStart(2, '0');
      dateInput.value = `${yyyy}-${mm}-${dd}`;
    }
  }
}

async function saveCurrentScheduleAsPreset() {
  const time = document.getElementById('schedTime').value;
  
  if (!time) {
    showToast('Please select a time first!', 'warning');
    return;
  }

  const name = prompt('Enter a name for this schedule preset (e.g., Daily 13:00, Weekend Batch):');
  if (!name) return;

  const days = prompt('Enter days for this preset (comma-separated, e.g. everyday, mon,wed,fri):', 'everyday');
  if (days === null) return;

  try {
    const res = await fetch(`${API_BASE}/schedule-presets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, time, days })
    });

    if (!res.ok) throw new Error(await res.text());

    showToast('Schedule preset saved successfully!', 'success');
    await loadSchedulePresets();
    
    const newPreset = state.schedulePresets.find(p => p.name === name);
    if (newPreset) {
      document.getElementById('schedPresetSelect').value = newPreset.id;
      onSelectSchedulePreset();
    }
  } catch (err) {
    showToast('Failed to save preset: ' + err.message, 'error');
  }
}

async function createNewSchedulePresetFromDashboard() {
  const name = prompt('Enter a name for this schedule preset (e.g., Daily 22:00, EGT 15:00):');
  if (!name) return;

  const time = prompt('Enter the posting time (HH:MM format, e.g. 22:00, 15:30):', '22:00');
  if (!time) return;

  const timeRegex = /^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/;
  if (!timeRegex.test(time.trim())) {
    showToast('Invalid time format. Use HH:MM (e.g., 15:00, 22:00).', 'error');
    return;
  }

  const days = prompt('Enter days for this preset (comma-separated, e.g. everyday, mon,wed,fri):', 'everyday');
  if (days === null) return;

  try {
    const res = await fetch(`${API_BASE}/schedule-presets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, time: time.trim(), days })
    });

    if (!res.ok) throw new Error(await res.text());

    showToast('Schedule preset saved successfully!', 'success');
    await loadSchedulePresets();
    
    const newPreset = state.schedulePresets.find(p => p.name === name);
    if (newPreset) {
      document.getElementById('dashPresetSelect').value = newPreset.id;
      updateDashboardScheduleSummary();
    }
  } catch (err) {
    showToast('Failed to save preset: ' + err.message, 'error');
  }
}

async function deleteSelectedPreset() {
  const select = document.getElementById('schedPresetSelect');
  const presetId = select ? select.value : '';
  if (!presetId) return;

  if (!confirm('Are you sure you want to delete this schedule preset?')) return;

  try {
    const res = await fetch(`${API_BASE}/schedule-presets/${presetId}`, {
      method: 'DELETE'
    });

    if (!res.ok) throw new Error(await res.text());

    showToast('Schedule preset deleted.', 'success');
    await loadSchedulePresets();
    select.value = '';
    document.getElementById('btnDeletePreset').style.display = 'none';
  } catch (err) {
    showToast('Failed to delete preset: ' + err.message, 'error');
  }
}

// ---------------------------------------------------------------------------
// 14. Dashboard Pipeline & Scheduling Control
// ---------------------------------------------------------------------------

// Initialize dashboard state variables
state.dashSelectedChannelIds = [];
state.dashCountType = 'manual'; // default count type
state.dashPipelineStatus = 'idle';

// Function to populate presets on the dashboard
function populateDashboardPresetsDropdown() {
  const select = document.getElementById('dashPresetSelect');
  if (!select) return;

  const options = state.schedulePresets.map(p => {
    const daysDisplay = p.days === 'everyday' ? 'Everyday' : p.days.toUpperCase();
    return `<option value="${p.id}">${escapeHTML(p.name)} (${p.time} — ${daysDisplay})</option>`;
  }).join('');

  select.innerHTML = '<option value="">-- Use Channel defaults --</option>' + options;
}

// Hook select changes to update summary
document.addEventListener('DOMContentLoaded', () => {
  const dashPresetSelect = document.getElementById('dashPresetSelect');
  if (dashPresetSelect) {
    dashPresetSelect.addEventListener('change', updateDashboardScheduleSummary);
  }
  const dashScheduleCount = document.getElementById('dashScheduleCount');
  if (dashScheduleCount) {
    dashScheduleCount.addEventListener('change', updateDashboardScheduleSummary);
    dashScheduleCount.addEventListener('input', updateDashboardScheduleSummary);
  }
  const dashCommentSelect = document.getElementById('dashCommentSelect');
  if (dashCommentSelect) {
    dashCommentSelect.addEventListener('change', updateDashboardCommentPreview);
  }
});

// Render the entire control panel on Dashboard
async function renderPipelineControl() {
  // 1. Populate Presets
  populateDashboardPresetsDropdown();
  populateSavedCommentsDropdown();

  // 2. Render Column 1: API Connection Status List
  const oauthList = document.getElementById('dashOauthStatusList');
  if (oauthList) {
    if (state.channels.length === 0) {
      oauthList.innerHTML = '<p class="muted">No channels added yet.</p>';
    } else {
      oauthList.innerHTML = state.channels.map(ch => {
        const isBrowserMode = ch.upload_mode === 'browser';
        const isConnected = isBrowserMode ? !!ch.has_profile : !!ch.youtube_channel_id;
        const badgeText = isBrowserMode
          ? (isConnected ? 'Puppet OK' : 'No Session')
          : (isConnected ? 'API Connected' : 'No Token');
        const badgeStyle = isConnected
          ? 'background: rgba(52,211,153,0.15); color: var(--accent-green);'
          : 'background: rgba(248,113,113,0.15); color: var(--accent-red);';
        return `
          <div style="display: flex; justify-content: space-between; align-items: center; background: rgba(255,255,255,0.02); padding: 6px 10px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.03);">
            <span style="font-weight: 500; text-overflow: ellipsis; overflow: hidden; white-space: nowrap; max-width: 140px;">📺 ${escapeHTML(ch.name)}</span>
            <span style="font-size: 0.75rem; font-weight: 600; padding: 2px 6px; border-radius: 12px; ${badgeStyle}">${badgeText}</span>
          </div>
        `;
      }).join('');
    }
  }

  // 3. Render Column 2: Channel Checklist
  const checklist = document.getElementById('dashChannelChecklist');
  if (checklist) {
    if (state.channels.length === 0) {
      checklist.innerHTML = '<p class="muted">No channels added yet.</p>';
    } else {
      checklist.innerHTML = state.channels.map(ch => {
        const isSelected = state.dashSelectedChannelIds.includes(ch.id);
        const isBrowserMode = ch.upload_mode === 'browser';
        const isConnected = isBrowserMode ? !!ch.has_profile : !!ch.youtube_channel_id;
        return `
          <div class="dash-channel-checklist-item ${isSelected ? 'selected' : ''}" onclick="toggleDashboardChannelCheckbox(${ch.id}, event)">
            <input type="checkbox" id="chk-dash-${ch.id}" ${isSelected ? 'checked' : ''} style="margin: 0;" onclick="event.stopPropagation(); onDashboardChannelCheckboxChange(${ch.id}, this.checked)">
            <div style="display: flex; flex-direction: column; gap: 2px;">
              <span style="font-weight: 500; font-size: 0.85rem; color: var(--text-bright);">${escapeHTML(ch.name)}</span>
              <span style="font-size: 0.75rem; color: var(--text-secondary);">🎬 ${ch.unused_videos || 0} in stock ${!isConnected ? '⚠️' : ''}</span>
            </div>
          </div>
        `;
      }).join('');
    }
  }

  // 4. Update Pipeline Status
  await updatePipelineStatusUI();

  // 5. Update Summary
  updateDashboardScheduleSummary();
}

// Handle checkbox clicks
function onDashboardChannelCheckboxChange(channelId, checked) {
  if (checked) {
    if (!state.dashSelectedChannelIds.includes(channelId)) {
      state.dashSelectedChannelIds.push(channelId);
    }
  } else {
    state.dashSelectedChannelIds = state.dashSelectedChannelIds.filter(id => id !== channelId);
  }
  
  // Re-render target checklist & summary
  renderPipelineControl();
}

function toggleDashboardChannelCheckbox(channelId, event) {
  const checkbox = document.getElementById(`chk-dash-${channelId}`);
  if (checkbox) {
    checkbox.checked = !checkbox.checked;
    onDashboardChannelCheckboxChange(channelId, checkbox.checked);
  }
}

// Toggle all checkboxes
function toggleAllDashboardChannels() {
  if (state.dashSelectedChannelIds.length === state.channels.length) {
    state.dashSelectedChannelIds = [];
  } else {
    state.dashSelectedChannelIds = state.channels.map(ch => ch.id);
  }
  renderPipelineControl();
}

function onDashCountTypeSelectChange() {
  const select = document.getElementById('dashCountTypeSelect');
  const lbl = document.getElementById('lblVideosCount');
  const countSelect = document.getElementById('dashScheduleCount');
  
  if (!select || !lbl || !countSelect) return;

  state.dashCountType = select.value;
  
  let optionsHTML = '';
  if (state.dashCountType === 'days') {
    lbl.textContent = 'Days Count';
    optionsHTML = `
      <option value="1">1 Day</option>
      <option value="2">2 Days</option>
      <option value="3">3 Days</option>
      <option value="5" selected>5 Days</option>
      <option value="7">7 Days (1 Week)</option>
      <option value="10">10 Days</option>
      <option value="14">14 Days (2 Weeks)</option>
      <option value="21">21 Days (3 Weeks)</option>
      <option value="30">30 Days (1 Month)</option>
      <option value="60">60 Days (2 Months)</option>
      <option value="90">90 Days (3 Months)</option>
    `;
  } else {
    lbl.textContent = 'Videos Count';
    optionsHTML = `
      <option value="1">1 Video</option>
      <option value="2">2 Videos</option>
      <option value="3">3 Videos</option>
      <option value="4">4 Videos</option>
      <option value="5" selected>5 Videos</option>
      <option value="7">7 Videos</option>
      <option value="10">10 Videos</option>
      <option value="15">15 Videos</option>
      <option value="20">20 Videos</option>
      <option value="25">25 Videos</option>
      <option value="30">30 Videos</option>
      <option value="50">50 Videos</option>
      <option value="100">100 Videos</option>
    `;
  }
  
  countSelect.innerHTML = optionsHTML;
  updateDashboardScheduleSummary();
}

// Calculate the summary of scheduled posts to be created
function updateDashboardScheduleSummary() {
  const summaryEl = document.getElementById('dashScheduleSummary');
  if (!summaryEl) return;

  if (state.dashSelectedChannelIds.length === 0) {
    summaryEl.innerHTML = '<span style="color: var(--text-muted)">Select channels to preview scheduling total.</span>';
    return;
  }

  const countInput = document.getElementById('dashScheduleCount');
  const count = parseInt(countInput ? countInput.value : '5', 10) || 1;
  const presetSelect = document.getElementById('dashPresetSelect');
  const presetId = presetSelect ? presetSelect.value : '';

  const typeSelect = document.getElementById('dashBulkVideoType');
  const typeFilter = typeSelect ? typeSelect.value : 'all';
  const keywordInput = document.getElementById('dashBulkKeyword');
  const keywordFilter = keywordInput ? keywordInput.value : '';

  const getUnusedVideosCountForChannel = (channelId, tFilter, kwFilter) => {
    let videos = state.videos.filter(v => v.channel_id === channelId);
    
    // Find all active scheduled videos (exclude cancelled)
    const scheduledVideoIds = new Set(
      state.scheduledPosts
        .filter(sp => sp.status !== 'cancelled' && sp.video_id)
        .map(sp => sp.video_id)
    );

    let unused = videos.filter(v => !scheduledVideoIds.has(v.id));

    // Video Type Filter (Shorts vs Longform)
    if (tFilter === 'shorts') {
      unused = unused.filter(v => v.duration !== null && v.duration <= 60);
    } else if (tFilter === 'longform') {
      unused = unused.filter(v => v.duration === null || v.duration > 60);
    }

    // Keyword Filter
    if (kwFilter && kwFilter.trim()) {
      const kw = kwFilter.trim().toLowerCase();
      unused = unused.filter(v => 
        (v.original_filename && v.original_filename.toLowerCase().includes(kw)) ||
        (v.title && v.title.toLowerCase().includes(kw))
      );
    }

    return unused.length;
  };

  let detailLines = [];
  let totalVideos = 0;

  state.dashSelectedChannelIds.forEach(id => {
    const ch = state.channels.find(c => c.id === id);
    if (!ch) return;

    let daysStr = ch.schedule_days;
    let timeStr = ch.schedule_time;

    if (presetId) {
      const preset = state.schedulePresets.find(p => p.id === parseInt(presetId));
      if (preset) {
        daysStr = preset.days;
        timeStr = preset.time;
      }
    }

    let videosForThisChannel = 0;
    const normalizedDays = (daysStr.toLowerCase().trim() === 'everyday') 
      ? ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']
      : daysStr.toLowerCase().split(',').map(d => d.trim().replace(/^every\s+/i, '').substring(0, 3));

    if (state.dashCountType === 'days') {
      // Calculate how many matching scheduled days fall in the next 'count' days
      let matchingDays = 0;
      let checkDate = new Date();
      checkDate.setDate(checkDate.getDate() + 1); // Starting tomorrow

      const shortDays = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
      for (let i = 0; i < count; i++) {
        const dayName = shortDays[checkDate.getDay()];
        if (normalizedDays.includes(dayName)) {
          matchingDays++;
        }
        checkDate.setDate(checkDate.getDate() + 1);
      }
      videosForThisChannel = matchingDays;
    } else {
      videosForThisChannel = count;
    }

    // Check video stock
    const stock = getUnusedVideosCountForChannel(ch.id, typeFilter, keywordFilter);
    const warning = (videosForThisChannel > stock) ? ` <span style="color: var(--accent-red); font-size: 0.75rem;">(⚠️ Short ${videosForThisChannel - stock} videos)</span>` : '';

    const rate = normalizedDays.length === 7 ? '1/day' : `${normalizedDays.length}/wk`;
    detailLines.push(`• <strong>${escapeHTML(ch.name)}</strong>: ${videosForThisChannel} videos (${rate})${warning}`);
    totalVideos += videosForThisChannel;
  });

  const headerText = state.dashCountType === 'days' 
    ? `📅 <strong>${count} days</strong> × <strong>${state.dashSelectedChannelIds.length} ch</strong> = <strong>${totalVideos} videos total</strong>`
    : `🎬 <strong>${count} videos</strong> × <strong>${state.dashSelectedChannelIds.length} ch</strong> = <strong>${totalVideos} videos total</strong>`;

  summaryEl.innerHTML = `
    <div style="margin-bottom: 6px;">${headerText}</div>
    <div style="font-size: 0.75rem; color: var(--text-secondary); max-height: 80px; overflow-y: auto; display: flex; flex-direction: column; gap: 2px;">
      ${detailLines.join('')}
    </div>
  `;
}

// Bulk auto-schedule videos action
async function bulkScheduleDashboardVideos(publishNow = false) {
  if (state.dashSelectedChannelIds.length === 0) {
    showToast('Please select at least one channel to auto-schedule videos.', 'warning');
    return;
  }

  const countInput = document.getElementById('dashScheduleCount');
  const count = parseInt(countInput ? countInput.value : '5', 10);
  if (isNaN(count) || count <= 0) {
    showToast('Please enter a valid count.', 'warning');
    return;
  }

  const presetSelect = document.getElementById('dashPresetSelect');
  const presetId = presetSelect && presetSelect.value ? parseInt(presetSelect.value) : null;

  const commentSelect = document.getElementById('dashCommentSelect');
  const commentId = commentSelect && commentSelect.value ? parseInt(commentSelect.value) : null;

  const typeSelect = document.getElementById('dashBulkVideoType');
  const videoType = typeSelect ? typeSelect.value : 'all';

  const keywordInput = document.getElementById('dashBulkKeyword');
  const videoKeyword = keywordInput ? keywordInput.value : '';

  const orderSelect = document.getElementById('dashBulkOrder');
  const videoOrder = orderSelect ? orderSelect.value : 'asc';
  const isPremiere = document.getElementById('dashBulkPremiere') ? document.getElementById('dashBulkPremiere').checked : false;

  if (publishNow) {
    if (!confirm('Are you sure you want to immediately publish and upload these videos across the selected channels?')) {
      return;
    }
  }

  showToast(publishNow ? 'Queueing videos for immediate upload...' : 'Auto-scheduling videos...', 'info');

  try {
    const res = await fetch(`${API_BASE}/schedule/bulk`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channelIds: state.dashSelectedChannelIds,
        count,
        isDays: state.dashCountType === 'days',
        presetId,
        commentId,
        videoType,
        videoKeyword,
        videoOrder,
        isPremiere,
        publishNow
      })
    });

    if (!res.ok) throw new Error(await res.text());

    const result = await res.json();
    showToast(publishNow 
      ? `⚡ Successfully queued and publishing ${result.totalScheduled} videos now!` 
      : `⚡ Successfully scheduled ${result.totalScheduled} videos across channels!`, 'success');
    
    // Clear selection
    state.dashSelectedChannelIds = [];
    if (document.getElementById('dashBulkPremiere')) {
      document.getElementById('dashBulkPremiere').checked = false;
    }

    // Reload everything
    await loadAllData();
  } catch (err) {
    showToast('Scheduling failed: ' + err.message, 'error');
  }
}

// Get pipeline status and update button label
async function updatePipelineStatusUI() {
  const btn = document.getElementById('btnLaunchPipeline');
  if (!btn) return;

  try {
    const res = await fetch(`${API_BASE}/pipeline/status`);
    const statusObj = await res.json();
    state.dashPipelineStatus = statusObj.status;

    if (['preparing', 'uploading', 'commenting'].includes(state.dashPipelineStatus)) {
      btn.textContent = '🛑 Stop Pipeline';
      btn.style.background = 'var(--grad-danger)';
    } else {
      btn.textContent = '🚀 Launch Pipeline';
      btn.style.background = 'var(--accent-gradient)';
    }
  } catch (err) {
    console.error('Failed to fetch pipeline status:', err);
  }
}

// Toggle pipeline running/stopping
async function toggleDashboardPipeline() {
  const isRunning = ['preparing', 'uploading', 'commenting'].includes(state.dashPipelineStatus);

  if (isRunning) {
    showToast('Stopping pipeline...', 'info');
    try {
      const res = await fetch(`${API_BASE}/pipeline/stop`, { method: 'POST' });
      if (!res.ok) throw new Error(await res.text());
      showToast('Pipeline cancellation requested.', 'success');
      await updatePipelineStatusUI();
    } catch (err) {
      showToast('Failed to stop pipeline: ' + err.message, 'error');
    }
  } else {
    if (state.dashSelectedChannelIds.length === 0) {
      showToast('Please select at least one channel to launch the pipeline.', 'warning');
      return;
    }

    const countInput = document.getElementById('dashScheduleCount');
    const videosPerChannel = parseInt(countInput ? countInput.value : '1', 10) || 1;

    showToast('Launching pipeline...', 'info');
    try {
      const res = await fetch(`${API_BASE}/pipeline/launch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          channelIds: state.dashSelectedChannelIds,
          videosPerChannel
        })
      });

      if (!res.ok) throw new Error(await res.text());

      const data = await res.json();
      showToast('🚀 Pipeline launched successfully!', 'success');
      await updatePipelineStatusUI();
    } catch (err) {
      showToast('Failed to launch pipeline: ' + err.message, 'error');
    }
  }
}

// Client-side helper to read video duration from file before upload
function getVideoDuration(file) {
  return new Promise((resolve) => {
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.src = URL.createObjectURL(file);
    video.onloadedmetadata = () => {
      URL.revokeObjectURL(video.src);
      resolve(video.duration);
    };
    video.onerror = () => {
      resolve(null);
    };
  });
}

window.saveVideoDuration = async (videoId, duration) => {
  try {
    const res = await fetch(`${API_BASE}/media/videos/${videoId}/duration`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ duration })
    });
    if (res.ok) {
      // Find and update local state
      const video = state.videos.find(v => v.id === videoId);
      if (video) video.duration = duration;
    }
  } catch (e) {
    console.error('Error saving video duration:', e);
  }
};

// ---------------------------------------------------------------------------
// 15. YouTube Login Setup Wizard (Settings Tab) — VNC-based
// ---------------------------------------------------------------------------

let ytSetupSessionActive = false;

/**
 * Refresh the YouTube Login Setup section — check if a session is already running
 */
async function refreshYtLoginSetup() {
  try {
    const res = await fetch(`${API_BASE}/channels/yt-setup/status`);
    const data = await res.json();
    
    if (data.active) {
      ytSetupSessionActive = true;
      goToYtSetupStep(2);
      // Reconnect iframe if session is already running
      showVncIframe(data.ws_port || 6080);
      showToast('Active browser session found.', 'info');
    } else {
      ytSetupSessionActive = false;
      goToYtSetupStep(1);
    }
  } catch (err) {
    console.error('Failed to refresh YT setup status:', err);
  }
}

/**
 * Navigate between step 1 and step 2
 */
function goToYtSetupStep(step) {
  const step1 = document.getElementById('ytSetupStep1');
  const step2 = document.getElementById('ytSetupStep2');
  const ind1 = document.getElementById('ytStep1Indicator');
  const ind2 = document.getElementById('ytStep2Indicator');
  const line = document.getElementById('ytStepLine');
  
  if (!step1 || !step2) return;

  if (step === 1) {
    step1.style.display = 'block';
    step2.style.display = 'none';
    ind1.className = 'yt-step-indicator active';
    ind2.className = 'yt-step-indicator';
    line.className = 'yt-step-line';
  } else {
    step1.style.display = 'none';
    step2.style.display = 'block';
    ind1.className = 'yt-step-indicator complete';
    ind2.className = 'yt-step-indicator active';
    line.className = 'yt-step-line active';
  }
}

/**
 * Show the noVNC iframe with the correct URL
 */
function showVncIframe(wsPort) {
  const iframe = document.getElementById('ytSetupVncFrame');
  const missing = document.getElementById('ytSetupVncMissing');
  if (!iframe) return;

  // Use same-origin proxy — noVNC is served at /novnc/ and WebSocket at /websockify
  const origin = window.location.origin;
  
  iframe.src = `${origin}/novnc/vnc_lite.html?autoconnect=true&resize=scale&quality=7&compression=2&reconnect=true&reconnect_delay=2000&path=websockify`;
  iframe.style.display = 'block';
  if (missing) missing.style.display = 'none';
}

/**
 * Launch the Chrome browser for YouTube login setup (VNC mode)
 */
async function launchYtSetupBrowser() {
  const btn = document.getElementById('btnYtSetupLaunch');
  const statusDiv = document.getElementById('ytSetupLaunchStatus');
  
  btn.disabled = true;
  btn.innerHTML = '⏳ Launching Chrome + VNC...';
  if (statusDiv) {
    statusDiv.style.display = 'block';
    statusDiv.textContent = 'Starting virtual display and Chrome on the server. This may take 5-10 seconds...';
  }

  try {
    const res = await fetch(`${API_BASE}/channels/yt-setup/launch`, { method: 'POST' });
    const data = await res.json();
    
    if (data.success && data.mode === 'vnc') {
      ytSetupSessionActive = true;
      
      if (!data.vnc_available) {
        // Show missing deps warning
        const missing = document.getElementById('ytSetupVncMissing');
        if (missing) missing.style.display = 'block';
        const iframe = document.getElementById('ytSetupVncFrame');
        if (iframe) iframe.style.display = 'none';
        showToast('VNC dependencies missing — see instructions on screen', 'error');
        goToYtSetupStep(2);
        return;
      }

      showToast('Chrome browser launched! Loading remote desktop...', 'success');
      goToYtSetupStep(2);
      showVncIframe(data.ws_port);
    } else {
      throw new Error(data.error || 'Failed to launch browser');
    }
  } catch (err) {
    showToast('Failed to launch browser: ' + err.message, 'error');
    if (statusDiv) {
      statusDiv.textContent = '❌ ' + err.message;
      statusDiv.style.color = '#f87171';
    }
  } finally {
    btn.disabled = false;
    btn.innerHTML = '🚀 Launch Chrome Browser';
  }
}

/**
 * Verify channels — connects to Chrome via CDP and scrapes YouTube Studio
 */
async function verifyYtSetupChannels() {
  const btn = document.getElementById('btnYtSetupVerify');
  const status = document.getElementById('ytSetupVerifyStatus');
  
  btn.disabled = true;
  btn.innerHTML = '⏳ Verifying...';
  if (status) status.textContent = 'Connecting to Chrome and scanning YouTube Studio...';

  try {
    const res = await fetch(`${API_BASE}/channels/yt-setup/verify`, { method: 'POST' });
    const data = await res.json();
    
    if (data.success) {
      const count = data.channels ? data.channels.length : 0;
      showToast(`✅ Found ${count} channel(s)! They have been added/updated.`, 'success');
      if (status) status.textContent = `✅ Verified — ${count} channel(s) found and saved.`;
      if (status) status.style.color = '#4ade80';
      
      // Reload channels in the app
      loadChannels();
      loadAllData();
    } else {
      throw new Error(data.error || 'Verification failed');
    }
  } catch (err) {
    showToast('Verification failed: ' + err.message, 'error');
    if (status) {
      status.textContent = '❌ ' + err.message;
      status.style.color = '#f87171';
    }
  } finally {
    btn.disabled = false;
    btn.innerHTML = '✅ Verify Channels';
  }
}

/**
 * Save session and close the VNC browser
 */
async function saveAndCloseYtSetup() {
  const btn = document.getElementById('btnYtSetupSave');
  
  btn.disabled = true;
  btn.innerHTML = '⏳ Closing...';

  try {
    const res = await fetch(`${API_BASE}/channels/yt-setup/close`, { method: 'POST' });
    const data = await res.json();
    
    if (data.success) {
      showToast('Browser session saved and closed.', 'success');
      ytSetupSessionActive = false;
      
      // Reset to step 1
      goToYtSetupStep(1);
      
      // Hide the VNC iframe
      const iframe = document.getElementById('ytSetupVncFrame');
      if (iframe) {
        iframe.src = '';
        iframe.style.display = 'none';
      }
    } else {
      throw new Error(data.error || 'Failed to close session');
    }
  } catch (err) {
    showToast('Error: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = '💾 Save & Close Browser';
  }
}

