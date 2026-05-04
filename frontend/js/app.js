console.log('✅ app.js loaded successfully');

// ==================== Toast Notification ====================

function copyToClipboard(text) {
  navigator.clipboard.writeText(text).then(() => {
    showToast('✅ Copied to clipboard');
  }).catch(err => {
    console.error('Copy failed:', err);
    showToast('❌ Copy failed', 'danger');
  });
}

function showToast(message, duration = 3000) {
  let toast = document.getElementById('app-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'app-toast';
    toast.style.cssText = 'position:fixed;bottom:24px;right:24px;background:#1e293b;color:#fff;padding:10px 18px;border-radius:8px;font-size:13px;font-weight:500;z-index:99999;box-shadow:0 4px 16px rgba(0,0,0,0.25);transition:opacity 0.3s;opacity:0;pointer-events:none;';
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.style.opacity = '1';
  clearTimeout(toast._hideTimer);
  toast._hideTimer = setTimeout(() => { toast.style.opacity = '0'; }, duration);
}

// ==================== Configuration ====================

// Use relative path for production hosting, but keep dynamic origin detection
const API_BASE = window.location.origin.includes('localhost') 
  ? 'http://localhost:8000/api' 
  : `${window.location.origin}/api`;

// Prompts will be loaded from server - initialized with placeholders
let DEFAULT_FUNCTIONAL_PROMPT = '';
let DEFAULT_UI_PROMPT = '';
let DEFAULT_COMBINED_PROMPT = '';
let DEFAULT_BUG_REPORT_PROMPT = '';

// ==================== Load Prompts from Server ====================

async function loadPromptsFromServer() {
  try {
    const response = await fetch(`${API_BASE}/prompts/all`);
    if (response.ok) {
      const data = await response.json();
      DEFAULT_FUNCTIONAL_PROMPT = data.prompts.functional || '';
      DEFAULT_UI_PROMPT = data.prompts.ui || '';
      DEFAULT_COMBINED_PROMPT = data.prompts.combined || '';
      DEFAULT_BUG_REPORT_PROMPT = data.prompts.bug_report || '';
      console.log('✅ Prompts loaded from server successfully');
      addDebugLog('✅ Test case and bug report prompts loaded from prompts.txt');
    } else {
      console.warn('⚠️ Failed to load prompts from server, using defaults');
      addDebugLog('⚠️ Could not load prompts from server');
    }
  } catch (error) {
    console.warn('⚠️ Error loading prompts:', error);
    addDebugLog('⚠️ Error loading prompts from server');
  }
}

// ==================== Global Variables ====================

let currentAgent = null;
let llmConfig = null;
let tfsConnected = false;
let llmConnected = false;
let selectedProvider = 'azure';
let providerApiKeys = {};
let providerModelOverrides = {};
let testcaseUiScreenshotFiles = [];

// Test case execution context for regeneration
let lastTestCaseExecutionData = null;
let lastTestCaseResult = null;
let lastTaskResult = null; // Store last task creation result for Excel export
let testCaseCount = 0;

// Extracted TFS project and collection info (from test plan URL)
let extractedTfsProject = null;
let extractedTfsCollectionUrl = null;

// Test case upload state
let parsedTestCases = [];
let selectedTestCaseIndices = [];
let availablePlans = [];
let selectedPlanId = null;
let availableSuites = [];
let selectedSuiteId = null;
let newSuiteName = null;
let isFetchingPlans = false;
let isFetchingSuites = false;

const PLAN_CACHE_TTL_MS = 3 * 60 * 1000;
const SUITE_CACHE_TTL_MS = 3 * 60 * 1000;
const planCache = new Map();
const suiteCache = new Map();

function getAuthCacheHint(tfsConfig = {}) {
  const user = (tfsConfig.username || '').trim().toLowerCase();
  if ((tfsConfig.pat_token || '').trim()) return 'pat';
  if (user) return `user:${user}`;
  return 'none';
}

function buildPlanCacheKey(collectionUrl, project, tfsConfig = {}, testPlanUrl = '') {
  return [
    (collectionUrl || '').trim().toLowerCase(),
    (project || '').trim().toLowerCase(),
    (testPlanUrl || '').trim().toLowerCase(),
    getAuthCacheHint(tfsConfig)
  ].join('|');
}

function buildSuiteCacheKey(collectionUrl, project, planId, tfsConfig = {}, testPlanUrl = '') {
  return [
    buildPlanCacheKey(collectionUrl, project, tfsConfig, testPlanUrl),
    String(planId || '')
  ].join('|');
}

function readFreshCache(cacheMap, key, ttlMs) {
  const cached = cacheMap.get(key);
  if (!cached) return null;
  if ((Date.now() - cached.ts) > ttlMs) {
    cacheMap.delete(key);
    return null;
  }
  return cached.data;
}

function writeCache(cacheMap, key, data) {
  cacheMap.set(key, { ts: Date.now(), data });
}

function clearPlanSuiteCache() {
  planCache.clear();
  suiteCache.clear();
}

function cacheProviderApiKey(provider) {
  const apiKeyEl = document.getElementById('llm-api-key');
  if (apiKeyEl && provider) {
    providerApiKeys[provider] = apiKeyEl.value;
  }
}

function cacheProviderModelOverride(provider) {
  const modelEl = document.getElementById('llm-model-override');
  if (modelEl && provider) {
    providerModelOverrides[provider] = modelEl.value;
  }
}

function applyProviderApiKey(provider) {
  const apiKeyEl = document.getElementById('llm-api-key');
  if (apiKeyEl && provider) {
    apiKeyEl.value = providerApiKeys[provider] || '';
  }
}

function applyProviderModelOverride(provider) {
  const modelEl = document.getElementById('llm-model-override');
  if (modelEl && provider) {
    modelEl.value = providerModelOverrides[provider] || '';
  }
}

function persistProviderKeyMap() {
  sessionStorage.setItem('llm_provider_keys', JSON.stringify(providerApiKeys));
}

function persistProviderModelMap() {
  sessionStorage.setItem('llm_provider_models', JSON.stringify(providerModelOverrides));
}

// ==================== Dashboard Download Logic ====================

function toggleDownloadDropdown() {
  const dropdown = document.getElementById('download-options');
  if (dropdown) {
    dropdown.style.display = dropdown.style.display === 'block' ? 'none' : 'block';
  }
}

async function downloadDashboard(format) {
  const dashContent = document.getElementById('dashboard-content');
  const dropdown = document.getElementById('download-options');
  if (!dashContent) return;

  // Verify libraries are loaded
  if (typeof html2canvas === 'undefined' || (format === 'pdf' && !window.jspdf)) {
    showToast('Required libraries (html2canvas/jsPDF) are not loaded. Please refresh.', 'danger');
    console.error('Missing libraries:', { html2canvas: typeof html2canvas, jspdf: !!window.jspdf });
    return;
  }

  // Hide dropdown and show loading state
  if (dropdown) dropdown.style.display = 'none';
  const downloadBtn = document.querySelector('#download-dash-dropdown .dash-copy-btn');
  if (!downloadBtn) return;
  
  const originalHtml = downloadBtn.innerHTML;
  downloadBtn.innerHTML = '<span>⏳</span> Processing...';
  downloadBtn.disabled = true;

  try {
    console.log(`Starting dashboard export: ${format}`);
    // 1. Prepare element for capture
    dashContent.classList.add('pdf-export-mode');
    
    // Auto-expand all <details> elements so they are visible in PDF
    const detailsEls = dashContent.querySelectorAll('details');
    const originalDetailsStates = [];
    detailsEls.forEach(details => {
      originalDetailsStates.push({ el: details, open: details.open });
      details.open = true;
    });

    // Hide ALL unwanted elements during capture (buttons, nav chips, tooltips, search bars)
    const toHide = Array.from(dashContent.querySelectorAll('.dash-chart-btn, .dash-copy-btn, .dash-nav-chip, .dash-tip, .dash-search'));
    
    // Also find the parent containers of search bars to avoid empty gaps
    dashContent.querySelectorAll('.dash-search').forEach(sb => {
      if (sb.parentElement && !toHide.includes(sb.parentElement)) {
        toHide.push(sb.parentElement);
      }
    });

    const originalStyles = [];
    toHide.forEach(el => {
      originalStyles.push({ el, display: el.style.display });
      el.style.display = 'none';
    });

    // --- ENHANCED HEIGHT CALCULATION ---
    // Temporarily force everything to be visible and unconstrained to get accurate scrollHeight
    const originalDashStyle = {
      overflow: dashContent.style.overflow,
      height: dashContent.style.height,
      maxHeight: dashContent.style.maxHeight
    };
    dashContent.style.overflow = 'visible';
    dashContent.style.height = 'auto';
    dashContent.style.maxHeight = 'none';

    // Get the full height after expansion
    const captureWidth = 1200;
    const captureHeight = dashContent.scrollHeight;
    console.log(`Calculated capture height: ${captureHeight}px`);

    // 2. Capture using html2canvas with optimized settings
    const canvas = await html2canvas(dashContent, {
      scale: 1.5, // Balanced quality/memory to prevent corruption
      useCORS: true,
      logging: false,
      backgroundColor: '#ffffff',
      width: captureWidth,
      height: captureHeight,
      windowWidth: captureWidth,
      windowHeight: captureHeight,
      scrollX: 0,
      scrollY: 0,
      imageTimeout: 0,
      onclone: (clonedDoc) => {
        // Force the cloned element to be fully expanded and visible
        const clonedDash = clonedDoc.getElementById('dashboard-content');
        if (clonedDash) {
          clonedDash.style.overflow = 'visible';
          clonedDash.style.height = 'auto';
          clonedDash.style.maxHeight = 'none';
          
          // Ensure all parents in the clone are visible and don't scroll
          let parent = clonedDash.parentElement;
          while (parent && parent.tagName !== 'BODY') {
            parent.style.overflow = 'visible';
            parent.style.height = 'auto';
            parent.style.maxHeight = 'none';
            parent = parent.parentElement;
          }
        }
      }
    });

    // Restore original dashContent styles immediately after capture
    dashContent.style.overflow = originalDashStyle.overflow;
    dashContent.style.height = originalDashStyle.height;
    dashContent.style.maxHeight = originalDashStyle.maxHeight;
    // --- END ENHANCED HEIGHT CALCULATION ---

    // 3. Process based on format
    const filename = `Dashboard_${new Date().getTime()}`;

    if (format === 'image') {
      const link = document.createElement('a');
      link.download = `${filename}.jpg`;
      link.href = canvas.toDataURL('image/jpeg', 0.9);
      link.click();
      showToast('Dashboard saved as Image', 'success');
    } else if (format === 'pdf') {
      const { jsPDF } = window.jspdf;
      // Use JPEG for PDF to avoid "corrupt PNG" errors and transparency issues
      const imgData = canvas.toDataURL('image/jpeg', 0.95);
      
      const pdf = new jsPDF({
        orientation: 'p',
        unit: 'px',
        format: [canvas.width / 2, canvas.height / 2]
      });

      pdf.addImage(imgData, 'JPEG', 0, 0, canvas.width / 2, canvas.height / 2);
      pdf.save(`${filename}.pdf`);
      showToast('Dashboard saved as PDF', 'success');
    }

    // 4. Restore element state
    originalStyles.forEach(s => s.el.style.display = s.display);
    originalDetailsStates.forEach(s => s.el.open = s.open);
    dashContent.classList.remove('pdf-export-mode');
    console.log('Dashboard export completed successfully');

  } catch (err) {
    console.error('Download failed:', err);
    showToast(`Download failed: ${err.message || 'Unknown error'}`, 'danger');
  } finally {
    downloadBtn.innerHTML = originalHtml;
    downloadBtn.disabled = false;
  }
}

// Close download dropdown on outside click
document.addEventListener('click', (e) => {
  const container = document.getElementById('download-dash-dropdown');
  const options = document.getElementById('download-options');
  if (container && !container.contains(e.target) && options) {
    options.style.display = 'none';
  }
});

// ==================== Bug Creation State ====================

let bugTags = [];
let selectedScreenshots = [];

function toggleBugTag(button, tag) {
  if (bugTags.includes(tag)) {
    bugTags = bugTags.filter(t => t !== tag);
    button.style.background = '#f1f5f9';
    button.style.borderColor = '#cbd5e1';
  } else {
    bugTags.push(tag);
    button.style.background = '#dcfce7';
    button.style.borderColor = '#86efac';
    button.style.color = '#15803d';
  }
}

function initializeBugCreationUI() {
  const messageInput = document.getElementById('bug-message-input');
  const screenshotInput = document.getElementById('bug-screenshot-input');
  const assignedInput = document.getElementById('bug-assigned-input');
  const assignedDropdown = document.getElementById('bug-assigned-dropdown');
  
  // Auto-fetch Area, Iteration, and Team Members on load
  autoFetchDefaultValues();
  
  if (messageInput) {
    messageInput.addEventListener('keydown', function(e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendBugMessage();
      }
    });
  }
  
  // Handle multiple screenshots
  if (screenshotInput) {
    screenshotInput.addEventListener('change', function(e) {
      if (this.files && this.files.length > 0) {
        selectedScreenshots = Array.from(this.files);
        const fileNames = selectedScreenshots.map(f => f.name).join(', ');
        const totalSize = selectedScreenshots.reduce((sum, f) => sum + f.size, 0) / 1024;
        addDebugLog(`📎 ${selectedScreenshots.length} screenshot(s) selected: ${totalSize.toFixed(2)} KB total`);
        
        const messageInput = document.getElementById('bug-message-input');
        if (messageInput) {
          messageInput.placeholder = `Your message... 📎 ${selectedScreenshots.length} file(s) attached`;
        }
      }
    });
  }
  
  // Handle Assigned To search - with cached team members
  if (assignedInput) {
    let allMembers = [];
    let teamMembersError = null;
    let teamMembersLoaded = false;
    
    // Fetch all team members on focus
    assignedInput.addEventListener('focus', async function() {
      if (!teamMembersLoaded && !teamMembersError) {
        try {
          const tfsConfig = getTFSConfig();
          console.log('🔍 Fetching team members on focus');
          
          const response = await fetch(`${API_BASE}/tfs/team-members`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              search_query: '',
              tfs_config: tfsConfig
            })
          });
          
          const data = await response.json();
          console.log('📬 Team members response:', data);
          
          teamMembersLoaded = true;
          
          if (!data.success) {
            teamMembersError = data.error || "Failed to load team members";
            console.error('❌ Team members error:', teamMembersError);
            
            let errorHtml = `
              <div style="padding:10px;color:#dc2626;font-size:0.85rem;font-weight:600;">
                ⚠️ ${teamMembersError}
              </div>
            `;
            
            if (data.hint) {
              errorHtml += `
                <div style="padding:8px;color:#666;font-size:0.8rem;border-top:1px solid #e5e7eb;margin-top:6px;background:#f9fafb;border-radius:0 0 6px 6px;">
                  <div style="font-weight:600;margin-bottom:4px;">Format examples:</div>
                  <div style="font-family:monospace;font-size:0.75rem;line-height:1.4;">
                    • DGSL\\suraj<br/>
                    • DOMAIN\\username<br/>
                    • Suraj Yadav &lt;suraj@company.com&gt;
                  </div>
                </div>
              `;
            }
            
            assignedDropdown.innerHTML = errorHtml;
            assignedDropdown.style.display = 'block';
          } else if (data.members && data.members.length > 0) {
            allMembers = data.members;
            showAssignedToDropdown(allMembers, assignedDropdown);
            console.log('✅ Loaded ' + allMembers.length + ' team members');
            addDebugLog(`✅ Loaded ${allMembers.length} team members on focus`);
          } else {
            console.warn('⚠️ No team members returned');
            assignedDropdown.innerHTML = `
              <div style="padding:10px;color:#f97316;font-size:0.85rem;font-weight:600;">
                ℹ️ No team members found in TFS
              </div>
            `;
            assignedDropdown.style.display = 'block';
          }
        } catch (err) {
          teamMembersLoaded = true;
          console.error('Exception fetching team members:', err.message);
          assignedDropdown.innerHTML = `
            <div style="padding:10px;color:#dc2626;font-size:0.85rem;">
              ❌ Error: ${err.message}
            </div>
          `;
          assignedDropdown.style.display = 'block';
        }
      } else if (teamMembersLoaded && allMembers.length > 0) {
        // Already loaded, just show
        showAssignedToDropdown(allMembers, assignedDropdown);
        assignedDropdown.style.display = 'block';
      } else if (teamMembersError) {
        assignedDropdown.style.display = 'block';
      }
    });
    
    // Filter as user types
    assignedInput.addEventListener('input', function() {
      const query = this.value.trim();
      const queryLower = query.toLowerCase();
      
      if (allMembers.length > 0) {
        const filtered = allMembers.filter(m => 
          m.display_name.toLowerCase().includes(queryLower) || 
          m.email.toLowerCase().includes(queryLower)
        );
        if (filtered.length > 0) {
          showAssignedToDropdown(filtered, assignedDropdown);
        } else {
          assignedDropdown.innerHTML = `
            <div style="padding:10px;color:#666;font-size:0.85rem;text-align:center;">
              No matches for "${query}"
            </div>
          `;
          assignedDropdown.style.display = 'block';
        }
      } else if (teamMembersError) {
        if (query.length > 0) {
          const isValidFormat = (
            query.includes('\\') ||
            query.includes('<') ||
            query.includes('@')
          );
          
          if (isValidFormat) {
            assignedDropdown.innerHTML = `
              <div style="padding:10px;font-size:0.85rem;">
                <div onclick="selectAssignedToManual('${escapeHtml(query)}', '${escapeHtml(query)}');" 
                     style="padding:8px;background:#dcfce7;border:1px solid #86efac;border-radius:4px;cursor:pointer;font-weight:600;color:#16a34a;">
                  ✓ Use "${escapeHtml(query)}" as TFS identity
                </div>
              </div>
            `;
          } else {
            assignedDropdown.innerHTML = `
              <div style="padding:10px;font-size:0.85rem;">
                <div style="color:#666;margin-bottom:8px;">
                  ⚠️ Team members couldn't be loaded. Enter a TFS identity:
                </div>
              </div>
            `;
          }
          assignedDropdown.style.display = 'block';
        }
      }
    });
    
    document.addEventListener('click', function(e) {
      if (e.target !== assignedInput && !assignedDropdown.contains(e.target)) {
        assignedDropdown.style.display = 'none';
      }
    });
  }
  
  // Handle Link Story (work items) with search and filter
  const relatedWorkInput = document.getElementById('bug-related-work-input');
  if (relatedWorkInput) {
    let allWorkItems = [];
    let workItemsLoaded = false;
    
    // Auto-fetch work items on page load
    (async function fetchWorkItems() {
      try {
        const tfsConfig = getTFSConfig();
        if (!tfsConfig || !tfsConfig.base_url) {
          console.warn('⚠️ TFS config not available, skipping work items fetch');
          addDebugLog('⚠️ TFS config not saved - work items will be available on demand');
          return;
        }
        
        const response = await fetch(`${API_BASE}/tfs/work-items`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            base_url: tfsConfig.base_url,
            username: tfsConfig.username || '',
            password: tfsConfig.password || '',
            pat_token: tfsConfig.pat_token || ''
          })
        });
        
        const data = await response.json();
        if (data.success && data.work_items && data.work_items.length > 0) {
          allWorkItems = data.work_items;
          workItemsLoaded = true;
          console.log(`✅ Pre-loaded ${allWorkItems.length} work items for linking`);
          addDebugLog(`✅ Work items loaded for linking (${allWorkItems.length} available)`);
        } else {
          const errorMsg = data.message || data.error || 'No work items found';
          console.warn('⚠️ Work items fetch:', errorMsg);
          addDebugLog(`⚠️ Work items fetch: ${errorMsg}`);
        }
      } catch (err) {
        console.error('Exception pre-loading work items:', err.message);
        addDebugLog(`❌ Work items fetch error: ${err.message}`);
      }
    })();
    
    // Show work items on focus, with filtering
    relatedWorkInput.addEventListener('input', function() {
      const query = this.value.trim();
      
      if (!query || query.length === 0) {
        relatedWorkInput.title = 'Enter story/task ID or search by title';
        return;
      }
      
      if (!workItemsLoaded || allWorkItems.length === 0) {
        relatedWorkInput.title = 'No work items loaded yet';
        return;
      }
      
      // Filter by ID or title
      const filtered = allWorkItems.filter(item => {
        const itemId = String(item.id);
        const itemTitle = (item.title || '').toLowerCase();
        const queryLower = query.toLowerCase();
        return itemId.includes(query) || itemTitle.includes(queryLower);
      });
      
      if (filtered.length > 0) {
        relatedWorkInput.title = `Found: ${filtered.map(w => `#${w.id}`).join(', ')}`;
        console.log(`🔎 Found ${filtered.length} matching work items`);
      } else {
        relatedWorkInput.title = `No matches for "${query}"`;
      }
    });
  }
  
  // Handle Iteration search (similar to Assigned To)
  const iterationInput = document.getElementById('bug-iteration-input');
  const iterationDropdown = document.getElementById('bug-iteration-dropdown');
  
  if (iterationInput) {
    let allIterations = [];
    let iterationsError = null;
    
    // Fetch all iterations on focus
    iterationInput.addEventListener('focus', async function() {
      if (allIterations.length === 0 && !iterationsError) {
        try {
          const tfsConfig = getTFSConfig();
          
          const response = await fetch(`${API_BASE}/tfs/iterations`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              base_url: tfsConfig?.base_url || '',
              username: tfsConfig?.username || '',
              password: tfsConfig?.password || '',
              pat_token: tfsConfig?.pat_token || ''
            })
          });
          
          const data = await response.json();
          
          if (!data.success) {
            iterationsError = data.error || "Failed to load iterations";
            console.error('❌ Iterations error:', iterationsError);
            addDebugLog(`❌ Iterations error: ${iterationsError}`);
            
            iterationDropdown.innerHTML = `
              <div style="padding:10px;color:#dc2626;font-size:0.85rem;font-weight:600;">
                ⚠️ Could not load iterations
              </div>
            `;
            iterationDropdown.style.display = 'block';
          } else if (data.iterations && data.iterations.length > 0) {
            allIterations = data.iterations;
            showIterationDropdown(allIterations, iterationDropdown);
            console.log('✅ Loaded ' + allIterations.length + ' iterations');
            addDebugLog(`✅ Loaded ${allIterations.length} iterations`);
          } else {
            console.warn('⚠️ No iterations found');
            addDebugLog('⚠️ No iterations found in TFS');
            iterationDropdown.innerHTML = `
              <div style="padding:10px;color:#f97316;font-size:0.85rem;font-weight:600;">
                ℹ️ No iterations found in TFS
              </div>
            `;
            iterationDropdown.style.display = 'block';
          }
        } catch (err) {
          console.error('Exception fetching iterations:', err.message);
          addDebugLog(`❌ Exception: ${err.message}`);
          iterationDropdown.innerHTML = `
            <div style="padding:10px;color:#dc2626;font-size:0.85rem;">
              ❌ Error: ${err.message}
            </div>
          `;
          iterationDropdown.style.display = 'block';
        }
      } else if (iterationsError) {
        iterationDropdown.style.display = 'block';
      } else if (allIterations.length > 0) {
        iterationDropdown.style.display = 'block';
      }
    });
    
    iterationInput.addEventListener('input', function() {
      const searchText = this.value.toLowerCase();
      filterIterationDropdown(allIterations, searchText, iterationDropdown);
    });
    
    document.addEventListener('click', function(e) {
      if (e.target !== iterationInput && !iterationDropdown.contains(e.target)) {
        iterationDropdown.style.display = 'none';
      }
    });
  }
  
  console.log('Bug creation chat UI initialized');
}


async function autoFetchDefaultValues() {
  /**
   * Auto-fetch and populate Area, Iteration, and Team Members on page load
   */
  try {
    const tfsConfig = getTFSConfig();
    
    if (!tfsConfig || !tfsConfig.base_url) {
      console.warn('⚠️ TFS config not available, skipping auto-fetch');
      addDebugLog('⚠️ TFS config not saved yet - area, iteration, and team members will be loaded on demand');
      return;
    }
    
    console.log('🔄 Auto-fetching Area, Iteration, and Team Members...');
    addDebugLog('🔄 Auto-fetching Area, Iteration, and Team Members...');
    
    // Fetch all three in parallel
    const [areaResponse, iterationResponse, membersResponse] = await Promise.all([
      fetch(`${API_BASE}/tfs/areas`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          base_url: tfsConfig.base_url,
          username: tfsConfig.username || '',
          password: tfsConfig.password || '',
          pat_token: tfsConfig.pat_token || ''
        })
      }),
      fetch(`${API_BASE}/tfs/iterations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          base_url: tfsConfig.base_url,
          username: tfsConfig.username || '',
          password: tfsConfig.password || '',
          pat_token: tfsConfig.pat_token || ''
        })
      }),
      fetch(`${API_BASE}/tfs/team-members`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ search_query: '', tfs_config: tfsConfig })
      })
    ]);
    
    const areaData = await areaResponse.json();
    const iterationData = await iterationResponse.json();
    const membersData = await membersResponse.json();
    
    // Populate Area
    if (areaData.success && areaData.areas && areaData.areas.length > 0) {
      const defaultArea = areaData.areas[0];
      const areaInput = document.getElementById('wi-area');
      if (areaInput) {
        areaInput.value = defaultArea.path;
        areaInput.setAttribute('data-path', defaultArea.path);
        console.log(`✅ Auto-populated Area: ${defaultArea.path}`);
        addDebugLog(`✅ Auto-populated Area: ${defaultArea.path}`);
      }
    } else {
      const errorMsg = areaData.message || areaData.error || 'No areas found';
      console.warn('⚠️ Area fetch failed:', errorMsg);
      addDebugLog(`⚠️ Area auto-fetch failed: ${errorMsg}`);
    }
    
    // Populate Iteration
    if (iterationData.success && iterationData.iterations && iterationData.iterations.length > 0) {
      const defaultIter = iterationData.iterations.find(i => i.time_frame === 'current') || iterationData.iterations[0];
      const iterationInput = document.getElementById('wi-iteration');
      if (iterationInput) {
        iterationInput.value = defaultIter.display_name || defaultIter.path;
        iterationInput.setAttribute('data-path', defaultIter.path);
        console.log(`✅ Auto-populated Iteration: ${iterationInput.value}`);
        addDebugLog(`✅ Auto-populated Iteration: ${iterationInput.value}`);
      }
    } else {
      const errorMsg = iterationData.message || iterationData.error || 'No iterations found';
      console.warn('⚠️ Iteration fetch failed:', errorMsg);
      addDebugLog(`⚠️ Iteration auto-fetch failed: ${errorMsg}`);
    }
    
    // Populate Assign To
    if (membersData.success && membersData.members && membersData.members.length > 0) {
      const assignedInput = document.getElementById('wi-assigned');
      if (assignedInput) {
        assignedInput.placeholder = 'Select team member...';
        console.log(`✅ Team members loaded: ${membersData.members.length} available`);
        addDebugLog(`✅ Team members loaded: ${membersData.members.length} members available`);
      }
    } else {
      const errorMsg = membersData.error || 'No team members found';
      console.warn('⚠️ Team members fetch failed:', errorMsg);
      addDebugLog(`⚠️ Team members auto-fetch failed: ${errorMsg}`);
      const assignedInput = document.getElementById('wi-assigned');
      if (assignedInput) {
        assignedInput.placeholder = 'Enter manually or select from list...';
      }
    }
    
  } catch (error) {
    console.error('❌ Error auto-fetching default values:', error.message);
    addDebugLog(`❌ Error auto-fetching: ${error.message}`);
  }
}


function showAssignedToDropdown(members, dropdown) {
  if (members.length > 0) {
    dropdown.innerHTML = members.map((member, idx) => `
      <div class="dropdown-member-item" data-id="${escapeHtml(member.id)}" data-name="${escapeHtml(member.display_name)}" style="padding:10px;border-bottom:1px solid #e5e7eb;cursor:pointer;background:white;" onmouseover="this.style.background='#f3f4f6'" onmouseout="this.style.background='white'">
        <div style="font-weight:600;color:#1f2937;font-size:0.9rem;">${escapeHtml(member.display_name)}</div>
        <div style="font-size:0.8rem;color:#6b7280;">${escapeHtml(member.email)}</div>
      </div>
    `).join('');
    dropdown.style.display = 'block';
    // Add event listeners for dropdown items
    dropdown.querySelectorAll('.dropdown-member-item').forEach(item => {
      item.addEventListener('click', function() {
        selectAssignedTo(this.getAttribute('data-id'), this.getAttribute('data-name'));
      });
    });
  } else {
    dropdown.style.display = 'none';
  }
}

function selectAssignedTo(id, displayName) {
  document.getElementById('bug-assigned-input').value = displayName;
  document.getElementById('bug-assigned-input').setAttribute('data-id', id);
  document.getElementById('bug-assigned-dropdown').style.display = 'none';
}

function selectAssignedToManual(identity, displayName) {
  // Manual fallback when team members API fails
  // User entered a value and chose to use it as-is
  document.getElementById('bug-assigned-input').value = displayName;
  document.getElementById('bug-assigned-input').setAttribute('data-id', identity);
  document.getElementById('bug-assigned-dropdown').style.display = 'none';
  console.warn('⚠️ Using manually entered identity:', identity);
  addDebugLog(`⚠️ Using manually entered identity: ${identity}`);
}

function sendBugMessage() {
  const messageInput = document.getElementById('bug-message-input');
  const chatContainer = document.getElementById('bug-chat-container');
  const screenshotInput = document.getElementById('bug-screenshot-input');
  
  if (!messageInput || !chatContainer) return;
  
  const message = messageInput.value.trim();
  if (!message) return;
  
  // Add user message to chat
  const userMsg = document.createElement('div');
  userMsg.style.display = 'flex';
  userMsg.style.gap = '12px';
  userMsg.style.justifyContent = 'flex-end';
  
  let msgContent = `<div style="flex:0 0 auto;max-width:65%;background:#7c3aed;border-radius:8px;padding:12px;color:white;box-shadow:0 1px 2px rgba(0,0,0,0.1);word-wrap:break-word;">
    <div style="font-size:0.9rem;line-height:1.5;">${escapeHtml(message)}</div>`;
  
  if (screenshotInput && screenshotInput.files.length > 0) {
    msgContent += `<div style="background:rgba(255,255,255,0.2);border:1px solid rgba(255,255,255,0.3);border-radius:6px;padding:8px;font-size:0.8rem;display:flex;align-items:center;gap:6px;color:white;margin-top:8px;">
      <span>📎</span> ${screenshotInput.files[0].name}
    </div>`;
  }
  
  msgContent += '</div>';
  userMsg.innerHTML = msgContent;
  chatContainer.appendChild(userMsg);
  
  messageInput.value = '';
  
  // Show processing
  const processingMsg = document.createElement('div');
  processingMsg.style.display = 'flex';
  processingMsg.style.gap = '12px';
  
  processingMsg.innerHTML = `
    <div style="width:36px;height:36px;background:#7c3aed;border-radius:50%;display:flex;align-items:center;justify-content:center;color:white;flex-shrink:0;font-weight:600;font-size:0.8rem;margin-top:4px;">BA</div>
    <div style="flex:1;background:#f0fdf4;border:1px solid #dcfce7;border-radius:8px;padding:12px;box-shadow:0 1px 2px rgba(0,0,0,0.05);">
      <div style="font-size:0.85rem;color:#15803d;font-weight:600;">⏳ Formatting bug report...</div>
    </div>
  `;
  
  chatContainer.appendChild(processingMsg);
  chatContainer.scrollTop = chatContainer.scrollHeight;
  
  callFormatBugReportAPI(message, processingMsg, chatContainer);
}

function showIterationDropdown(iterations, dropdown) {
  if (iterations.length > 0) {
    dropdown.innerHTML = iterations.map((iter, idx) => `
      <div class="dropdown-iteration-item" data-path="${escapeHtml(iter.path)}" data-name="${escapeHtml(iter.display_name)}" style="padding:10px;border-bottom:1px solid #e5e7eb;cursor:pointer;background:white;" onmouseover="this.style.background='#f3f4f6'" onmouseout="this.style.background='white'">
        <div style="font-weight:600;color:#1f2937;font-size:0.9rem;">${escapeHtml(iter.display_name)}</div>
        <div style="font-size:0.8rem;color:#6b7280;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(iter.path)}</div>
      </div>
    `).join('');
    dropdown.style.display = 'block';
    // Add event listeners for dropdown items
    dropdown.querySelectorAll('.dropdown-iteration-item').forEach(item => {
      item.addEventListener('click', function() {
        selectIteration(this.getAttribute('data-path'), this.getAttribute('data-name'));
      });
    });
  } else {
    dropdown.style.display = 'none';
  }
}

function selectIteration(path, displayName) {
  document.getElementById('bug-iteration-input').value = displayName;
  document.getElementById('bug-iteration-input').setAttribute('data-path', path);
  document.getElementById('bug-iteration-dropdown').style.display = 'none';
}

function filterIterationDropdown(iterations, searchText, dropdown) {
  const filtered = iterations.filter(iter =>
    iter.display_name.toLowerCase().includes(searchText) ||
    iter.path.toLowerCase().includes(searchText)
  );
  
  if (filtered.length > 0) {
    dropdown.innerHTML = filtered.map((iter, idx) => `
      <div class="dropdown-iteration-item" data-path="${escapeHtml(iter.path)}" data-name="${escapeHtml(iter.display_name)}" style="padding:10px;border-bottom:1px solid #e5e7eb;cursor:pointer;background:white;" onmouseover="this.style.background='#f3f4f6'" onmouseout="this.style.background='white'">
        <div style="font-weight:600;color:#1f2937;font-size:0.9rem;">${escapeHtml(iter.display_name)}</div>
        <div style="font-size:0.8rem;color:#6b7280;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(iter.path)}</div>
      </div>
    `).join('');
    dropdown.style.display = 'block';
    // Add event listeners for dropdown items
    dropdown.querySelectorAll('.dropdown-iteration-item').forEach(item => {
      item.addEventListener('click', function() {
        selectIteration(this.getAttribute('data-path'), this.getAttribute('data-name'));
      });
    });
  } else {
    dropdown.innerHTML = '<div style="padding:10px;color:#6b7280;font-size:0.85rem;">No iterations found</div>';
    dropdown.style.display = 'block';
  }
}

async function callFormatBugReportAPI(bugDescription, processingMsg, chatContainer) {
  try {
    const llmConfigRaw = sessionStorage.getItem('llm_config');
    let llmConfig = null;
    if (llmConfigRaw) {
      llmConfig = JSON.parse(llmConfigRaw);
    }
    
    const screenshotInput = document.getElementById('bug-screenshot-input');
    let screenshotBase64 = null;
    let screenshotFileName = null;
    
    // Convert screenshot to base64 if present
    if (screenshotInput && screenshotInput.files.length > 0) {
      screenshotFileName = screenshotInput.files[0].name;
      try {
        screenshotBase64 = await fileToBase64(screenshotInput.files[0]);
      } catch (err) {
        addDebugLog(`⚠️ Could not read screenshot file: ${err.message}`);
      }
    }
    
    // Store formatted report for later use
    const response = await fetch(`${API_BASE}/agent/format-bug-report`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        bug_description: bugDescription,
        screenshot_file: screenshotBase64,
        screenshot_filename: screenshotFileName,
        llm_config: llmConfig
      })
    });
    
    const data = await response.json();
    
    if (data.success && data.formatted_report) {
      // Store the formatted report
      sessionStorage.setItem('formatted_bug_report', data.formatted_report);
      sessionStorage.setItem('bug_screenshot_base64', screenshotBase64 || '');
      sessionStorage.setItem('bug_screenshot_filename', screenshotFileName || '');
      
      // Extract title and steps from formatted report, preserving spacing
      const allLines = data.formatted_report.split('\n');
      const firstLine = allLines[0].trim();
      
      // Extract title: if it starts with "Title:", use that text; otherwise use the first line
      let bugTitle = firstLine;
      if (firstLine.toLowerCase().startsWith('title:')) {
        bugTitle = firstLine.substring(6).trim();
      }
      
      // Keep all remaining lines as steps, preserving original spacing
      const bugSteps = allLines.slice(1).join('\n');
      
      // Store in sessionStorage for later retrieval if needed
      sessionStorage.setItem('extracted_title', bugTitle);
      sessionStorage.setItem('extracted_steps', bugSteps);
      
      console.log('🔍 Looking for title input field...');
      console.log('All input elements on page:', document.querySelectorAll('input').length);
      console.log('All textarea elements on page:', document.querySelectorAll('textarea').length);
      
      // Try to find and fill the fields immediately
      let titleField = document.getElementById('bug-title-input');
      let stepsField = document.getElementById('bug-steps-input');
      
      console.log('Found title field:', !!titleField);
      console.log('Found steps field:', !!stepsField);
      
      if (titleField) {
        titleField.value = bugTitle;
        titleField.click();
        titleField.focus();
        titleField.dispatchEvent(new Event('input', { bubbles: true }));
        titleField.dispatchEvent(new Event('change', { bubbles: true }));
        console.log('✅ Directly filled title field. Value:', titleField.value);
      }
      
      if (stepsField) {
        stepsField.value = bugSteps;
        stepsField.click();
        stepsField.focus();
        stepsField.dispatchEvent(new Event('input', { bubbles: true }));
        stepsField.dispatchEvent(new Event('change', { bubbles: true }));
        console.log('✅ Directly filled steps field. Value length:', stepsField.value.length);
      }
      
      // Try again after a short delay as fallback
      setTimeout(() => {
        if (!titleField || !titleField.value) {
          let retry_titleField = document.getElementById('bug-title-input');
          console.log('Retry: found title field:', !!retry_titleField);
          if (retry_titleField && !retry_titleField.value) {
            retry_titleField.value = bugTitle;
            retry_titleField.dispatchEvent(new Event('input', { bubbles: true }));
            console.log('✅ Retry filled title. Value:', retry_titleField.value);
          }
        }
      }, 150);
      
      // Update processing message with formatted report
      processingMsg.innerHTML = `
        <div style="width:36px;height:36px;background:#7c3aed;border-radius:50%;display:flex;align-items:center;justify-content:center;color:white;flex-shrink:0;font-weight:600;font-size:0.8rem;margin-top:4px;">BA</div>
        <div style="flex:1;background:#f0fdf4;border:1px solid #dcfce7;border-radius:8px;padding:12px;box-shadow:0 1px 2px rgba(0,0,0,0.05);">
          <div style="font-size:0.85rem;color:#15803d;font-weight:600;margin-bottom:10px;">✅ Bug report formatted:</div>
          <div style="background:white;border:1px solid #dcfce7;border-radius:6px;padding:12px;font-size:0.8rem;color:#0f172a;white-space:pre-wrap;font-family:monospace;line-height:1.6;overflow-x:auto;max-height:500px;min-height:200px;">
            ${escapeHtml(data.formatted_report)}
          </div>
        </div>
      `;
      
      // Show TFS panel for final fields
      const tfsPanel = document.getElementById('bug-tfs-panel');
      if (tfsPanel) {
        tfsPanel.style.display = 'flex';
      }
      
      // Scroll to show panel
      setTimeout(() => {
        tfsPanel.scrollTop = 0;
      }, 100);
      
      // Reset screenshot input but keep reference
      const messageInput = document.getElementById('bug-message-input');
      if (messageInput) {
        messageInput.placeholder = 'Describe the bug...';
      }
    } else {
      processingMsg.innerHTML = `
        <div style="width:36px;height:36px;background:#7c3aed;border-radius:50%;display:flex;align-items:center;justify-content:center;color:white;flex-shrink:0;font-weight:600;font-size:0.8rem;margin-top:4px;">BA</div>
        <div style="flex:1;background:#fef2f2;border:1px solid #fecdd3;border-radius:8px;padding:12px;box-shadow:0 1px 2px rgba(0,0,0,0.05);">
          <div style="font-size:0.85rem;color:#b91c1c;font-weight:600;">❌ Error formatting bug report</div>
          <div style="font-size:0.8rem;color:#7f1d1d;margin-top:6px;">${data.error || 'Unknown error'}</div>
        </div>
      `;
    }
    chatContainer.scrollTop = chatContainer.scrollHeight;
  } catch (error) {
    processingMsg.innerHTML = `
      <div style="width:36px;height:36px;background:#7c3aed;border-radius:50%;display:flex;align-items:center;justify-content:center;color:white;flex-shrink:0;font-weight:600;font-size:0.8rem;margin-top:4px;">BA</div>
      <div style="flex:1;background:#fef2f2;border:1px solid #fecdd3;border-radius:8px;padding:12px;box-shadow:0 1px 2px rgba(0,0,0,0.05);">
        <div style="font-size:0.85rem;color:#b91c1c;font-weight:600;">❌ Connection error</div>
        <div style="font-size:0.8rem;color:#7f1d1d;margin-top:6px;">${error.message}</div>
      </div>
    `;
    addDebugLog(`❌ Bug formatting failed: ${error.message}`);
  }
}

async function createFormattedBugInTFS() {
  const formattedReport = sessionStorage.getItem('formatted_bug_report');
  const screenshotBase64 = sessionStorage.getItem('bug_screenshot_base64');
  const screenshotFileName = sessionStorage.getItem('bug_screenshot_filename');
  
  // Check if we're updating an existing bug
  const isUpdate = existingBugIdForUpdate !== null;
  
  if (!formattedReport && !isUpdate) {
    alert('❌ Please format a bug report first');
    return;
  }
  
  const priorityInput = document.getElementById('bug-priority-input');
  const severityInput = document.getElementById('bug-severity-input');
  const tagsInput = document.getElementById('bug-tags-input');
  const assignedInput = document.getElementById('bug-assigned-input');
  const relatedWorkInput = document.getElementById('bug-related-work-input');
  const stepsInput = document.getElementById('bug-steps-input');
  const areaInput = document.getElementById('bug-area-input');
  const iterationInput = document.getElementById('bug-iteration-input');
  
  console.log('🐛 CreateBug function called - Update mode:', isUpdate);
  console.log('Steps Input Found:', !!stepsInput);
  console.log('Assigned Input Found:', !!assignedInput);
  console.log('Area Input Found:', !!areaInput);
  console.log('Iteration Input Found:', !!iterationInput);
  
  try {
    const tfsConfig = getTFSConfig();
    const llmConfig = getLLMConfig();
    
    // For update mode, assigned_to can be empty (to keep existing value)
    // For create mode, assigned_to is required
    let assignedTo = assignedInput.getAttribute('data-id');
    
    if (!isUpdate) {
      // Validate that a proper team member was selected from the dropdown (only for create)
      if (!assignedTo) {
        console.error('❌ Assigned To validation failed');
        console.error('   data-id attribute:', assignedInput.getAttribute('data-id'));
        console.error('   input value:', assignedInput.value);
        
        const userValue = assignedInput.value.trim();
        let errorMsg = '⚠️ You must select a team member to assign the bug to.\n\n';
        
        if (!userValue) {
          errorMsg += 'Click in the "Assign To" field to see available team members.';
        } else {
          errorMsg += `"${userValue}" is not recognized as a valid TFS identity.\n\nEither:\n`;
          errorMsg += '1. Click on a matching name in the dropdown, or\n';
          errorMsg += '2. If you see "Use ... as TFS identity", click that option to use it as-is.';
        }
        
        alert(errorMsg);
        return;
      }
    }
    
    // Use steps from field, or fallback to entire formatted report for full details
    let reproductionSteps = stepsInput.value.trim();
    if (!reproductionSteps && !isUpdate) {
      // Send the full formatted report so backend can extract all sections
      reproductionSteps = formattedReport;
      console.log('Steps were empty, using full formatted report');
    }
    
    // Validate reproduction steps (only for create)
    if (!reproductionSteps && !isUpdate) {
      alert('⚠️ Reproduction steps are empty');
      return;
    }
    
    // Extract title from formatted report - should be first line after "Title:"
    let bugTitle = '';
    if (!isUpdate) {
      const titleMatch = formattedReport.match(/^Title:\s*(.+?)(?:\n|$)/i);
      bugTitle = (titleMatch && titleMatch[1]) ? titleMatch[1].substring(0, 120) : 'Bug Report';
    }
    
    // Convert all selected screenshots to base64
    let screenshotsData = [];
    if (selectedScreenshots && selectedScreenshots.length > 0) {
      for (const file of selectedScreenshots) {
        try {
          const base64 = await fileToBase64(file);
          screenshotsData.push({
            filename: file.name,
            data: base64
          });
        } catch (err) {
          addDebugLog(`⚠️ Could not read screenshot: ${file.name}`);
        }
      }
    }
    
    console.log('🚀 Extracted title:', bugTitle);
    console.log('🚀 Screenshots to attach:', screenshotsData.length);
    console.log('🚀 Is Update:', isUpdate, 'Bug ID:', existingBugIdForUpdate);
    
    // Use the same Agent endpoint for both Create and Update to ensure consistent quality/analysis
    const response = await fetch(`${API_BASE}/agent/create-bug-tfs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        bug_title: bugTitle,
        reproduction_steps: reproductionSteps,
        priority: priorityInput.value,
        severity: severityInput.value,
        tags: tagsInput.value.trim(),
        assigned_to: assignedTo,
        related_work_item_id: relatedWorkInput.value.trim() || null,
        work_item_id: isUpdate ? existingBugIdForUpdate : (relatedWorkInput.value.trim() || null),
        is_update: isUpdate,
        area_path: areaInput.value.trim() || null,
        iteration_path: iterationInput.getAttribute('data-path') || iterationInput.value.trim() || null,
        screenshots: screenshotsData,
        tfs_config: tfsConfig,
        llm_config: llmConfig
      })
    });
    
    const data = await response.json();
    
    if (data.success) {
      // Show success message with results
      const chatContainer = document.getElementById('bug-chat-container');
      const resultMsg = document.createElement('div');
      resultMsg.style.cssText = 'display:flex;gap:12px;margin-bottom:8px;';
      resultMsg.innerHTML = `
        <div style="width:36px;height:36px;background:#7c3aed;border-radius:50%;display:flex;align-items:center;justify-content:center;color:white;flex-shrink:0;font-weight:600;font-size:0.8rem;margin-top:4px;">BA</div>
        <div style="flex:1;background:#f0fdf4;border:1px solid #dcfce7;border-radius:8px;padding:12px;box-shadow:0 1px 2px rgba(0,0,0,0.05);">
          <div style="font-size:0.9rem;color:#15803d;font-weight:600;margin-bottom:8px;">✅ Bug ${isUpdate ? '#' + existingBugIdForUpdate : ''} ${isUpdate ? 'updated' : 'created'} successfully in TFS!</div>
          <div style="background:white;border:1px solid #dcfce7;border-radius:6px;padding:12px;font-size:0.85rem;color:#0f172a;line-height:1.8;">
            <div><strong>Bug ID:</strong> ${data.bug_id || existingBugIdForUpdate}</div>
            ${!isUpdate ? `<div><strong>Title:</strong> ${data.bug_title || bugTitle}</div>` : ''}
            <div><strong>Priority:</strong> ${priorityInput.selectedOptions[0].text}</div>
            <div><strong>Severity:</strong> ${severityInput.selectedOptions[0].text}</div>
            <div><strong>Assigned To:</strong> ${assignedInput.value || 'Unassigned'}</div>
            <div><strong>Tags:</strong> ${tagsInput.value || 'None'}</div>
            ${relatedWorkInput.value ? `<div><strong>Linked Story:</strong> ${relatedWorkInput.value}</div>` : ''}
            ${areaInput.value ? `<div><strong>Area:</strong> ${areaInput.value}</div>` : ''}
            ${iterationInput.value ? `<div><strong>Iteration:</strong> ${iterationInput.value}</div>` : ''}
          </div>
        </div>
      `;
      chatContainer.appendChild(resultMsg);
      chatContainer.scrollTop = chatContainer.scrollHeight;
      
      addDebugLog(`✅ Bug ${data.bug_id || existingBugIdForUpdate} ${isUpdate ? 'updated' : 'created'}`);
      
      // Clear session storage and inputs
      sessionStorage.removeItem('formatted_bug_report');
      sessionStorage.removeItem('bug_screenshot_base64');
      sessionStorage.removeItem('bug_screenshot_filename');
      
      setTimeout(() => {
        location.reload();
      }, 3000);
    } else {
      throw new Error(data.error || 'Unknown error');
    }
  } catch (error) {
    const chatContainer = document.getElementById('bug-chat-container');
    const errorMsg = document.createElement('div');
    errorMsg.style.cssText = 'display:flex;gap:12px;margin-bottom:8px;';
    errorMsg.innerHTML = `
      <div style="width:36px;height:36px;background:#7c3aed;border-radius:50%;display:flex;align-items:center;justify-content:center;color:white;flex-shrink:0;font-weight:600;font-size:0.8rem;margin-top:4px;">BA</div>
      <div style="flex:1;background:#fef2f2;border:1px solid #fecdd3;border-radius:8px;padding:12px;box-shadow:0 1px 2px rgba(0,0,0,0.05);">
        <div style="font-size:0.85rem;color:#b91c1c;font-weight:600;">❌ ${isUpdate ? 'Update' : 'Create'} failed:</div>
        <div style="font-size:0.8rem;color:#7f1d1d;margin-top:6px;">${error.message}</div>
      </div>
    `;
    chatContainer.appendChild(errorMsg);
    chatContainer.scrollTop = chatContainer.scrollHeight;
    addDebugLog(`❌ Operation failed: ${error.message}`);
  }
}

function getTFSConfig() {
  const configRaw = sessionStorage.getItem('tfs_config');
  if (!configRaw) return null;
  try {
    return JSON.parse(configRaw);
  } catch {
    return null;
  }
}

function getLLMConfig() {
  const configRaw = sessionStorage.getItem('llm_config');
  if (!configRaw) return null;
  try {
    return JSON.parse(configRaw);
  } catch {
    return null;
  }
}

// ==================== Bug Fetch & Update Logic ====================

let existingBugIdForUpdate = null; // Track if updating an existing bug

async function fetchExistingBugDetails() {
  const bugIdInput = document.getElementById('bug-existing-id-input');
  const bugId = bugIdInput.value.trim();
  
  if (!bugId) {
    alert('⚠️ Please enter a bug ID');
    return;
  }
  
  const statusDiv = document.getElementById('bug-fetch-status');
  
  try {
    statusDiv.textContent = 'Fetching...';
    statusDiv.style.display = 'block';
    statusDiv.style.color = '#0066cc';
    statusDiv.style.background = '#dbeafe';
    statusDiv.style.borderColor = '#bfdbfe';
    
    const tfsConfig = getTFSConfig();
    if (!tfsConfig || !tfsConfig.base_url) {
      throw new Error('TFS configuration not found. Please configure TFS first.');
    }
    
    const response = await fetch(`${API_BASE}/tfs/fetch-bug-details`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        bug_id: parseInt(bugId),
        tfs_config: tfsConfig
      })
    });
    
    const data = await response.json();
    
    if (data.success && data.bug_details) {
      const bug = data.bug_details;
      
      // Store the existing bug ID for later update operation
      existingBugIdForUpdate = parseInt(bugId);
      
      // Populate form fields with bug details (UPDATED IDs to match current form)
      const titleInput = document.getElementById('wi-title');
      const descInput = document.getElementById('wi-description');
      const priorityInput = document.getElementById('wi-priority');
      const severityInput = document.getElementById('wi-severity');
      const areaInput = document.getElementById('wi-area');
      const iterationInput = document.getElementById('wi-iteration');
      const tagsInput = document.getElementById('wi-tags');
      const assignedInput = document.getElementById('wi-assigned');
      
      if (titleInput) titleInput.value = bug.title || '';
      
      // Re-assemble description from backend fields if needed
      let fullDesc = '';
      if (bug.description && bug.reproduction_steps) {
         fullDesc = `**Description**\n${bug.description}\n\n**Steps to Reproduce**\n${bug.reproduction_steps}`;
      } else {
         fullDesc = bug.description || bug.reproduction_steps || '';
      }
      
      if (descInput) descInput.value = fullDesc;
      if (priorityInput) priorityInput.value = bug.priority || '2';
      if (severityInput) severityInput.value = bug.severity || '2 - High';
      if (areaInput) areaInput.value = bug.area_path || '';
      if (iterationInput) iterationInput.value = bug.iteration_path || '';
      if (tagsInput) tagsInput.value = bug.tags || '';
      
      if (assignedInput) {
          // Handle object if backend didn't convert it
          const assignedVal = bug.assigned_to;
          assignedInput.value = typeof assignedVal === 'object' ? 
            (assignedVal.displayName || assignedVal.uniqueName || '') : 
            String(assignedVal || '');
      }
      
      statusDiv.textContent = `✅ Bug #${bugId} loaded - Ready to update`;
      statusDiv.style.color = '#15803d';
      statusDiv.style.background = '#dcfce7';
      statusDiv.style.borderColor = '#86efac';
      
      // Update Execute button to indicate update mode
      const executeBtn = document.getElementById('bug-execute-btn');
      if (executeBtn) {
        executeBtn.textContent = '✏️ Update Bug';
      }
      
      addDebugLog(`✅ Bug #${bugId} details loaded for update`);
    } else {
      throw new Error(data.error || 'Failed to fetch bug details');
    }
  } catch (error) {
    statusDiv.textContent = `❌ ${error.message}`;
    statusDiv.style.color = '#b91c1c';
    statusDiv.style.background = '#fee2e2';
    statusDiv.style.borderColor = '#fecdd3';
    addDebugLog(`❌ Failed to fetch bug: ${error.message}`);
  }
}

async function updateExistingBug(bugId, bugData) {
  const tfsConfig = getTFSConfig();
  if (!tfsConfig) {
    throw new Error('TFS configuration not found');
  }
  
  const response = await fetch(`${API_BASE}/tfs/update-bug`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      bug_id: bugId,
      ...bugData,
      tfs_config: tfsConfig
    })
  });
  
  return await response.json();
}

function clearBugForm() {
  // Clear existing bug ID tracking
  existingBugIdForUpdate = null;
  
  // Reset fields
  document.getElementById('bug-existing-id-input').value = '';
  document.getElementById('bug-steps-input').value = '';
  document.getElementById('bug-priority-input').value = '2';
  document.getElementById('bug-severity-input').value = '2 - High';
  document.getElementById('bug-area-input').value = '';
  document.getElementById('bug-iteration-input').value = '';
  document.getElementById('bug-tags-input').value = '';
  document.getElementById('bug-assigned-input').value = '';
  document.getElementById('bug-related-work-input').value = '';
  
  // Reset execute button
  const executeBtn = document.getElementById('bug-execute-btn');
  if (executeBtn) {
    executeBtn.textContent = '▶️ Execute';
  }
  
  // Clear status
  const statusDiv = document.getElementById('bug-fetch-status');
  if (statusDiv) {
    statusDiv.style.display = 'none';
    statusDiv.textContent = '';
  }
  
  // Clear chat
  const chatContainer = document.getElementById('bug-chat-container');
  if (chatContainer) {
    const messages = chatContainer.querySelectorAll('div[style*="display:flex"]');
    messages.forEach((msg, idx) => {
      if (idx > 0) msg.remove(); // Keep first greeting
    });
  }
  
  addDebugLog('🔄 Bug form cleared');
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Convert File to base64 string
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = () => {
      resolve(reader.result);
    };
    reader.onerror = (error) => {
      reject(error);
    };
  });
}

// ==================== Debug Logging ====================

function addDebugLog(message) {
  const debugLog = document.getElementById('debug-log');
  const errorCount = document.getElementById('debug-error-count');
  const debugDot = document.getElementById('debug-dot');
  
  if (debugLog) {
    const timestamp = new Date().toLocaleTimeString();
    const logEntry = `[${timestamp}] ${message}`;
    
    // Append text directly (newlines preserved by CSS white-space: pre-wrap)
    if (debugLog.textContent) {
      debugLog.textContent += '\n' + logEntry;
    } else {
      debugLog.textContent = logEntry;
    }
    
    // Auto-scroll to bottom
    debugLog.scrollTop = debugLog.scrollHeight;
  }
  
  // Flash green dot when log is added
  if (debugDot) {
    debugDot.style.background = '#10b981';
    debugDot.style.transition = 'background 0.3s ease';
    setTimeout(() => {
      debugDot.style.background = '#6b7280';
    }, 1200);
  }
  
  // Increment error count if it's an error message
  if (message.startsWith('❌') && errorCount) {
    errorCount.style.display = 'inline-block';
    errorCount.textContent = (parseInt(errorCount.textContent) || 0) + 1;
  }
  
  // Also log to console
  console.log(message);
}

// ==================== Initialization ====================

// Initialize global state
window.allIterations = [];
window.fullIterationHTML = '';

document.addEventListener('DOMContentLoaded', async () => {
  console.log('DOM ready');
  
  // Load prompts from server first (TruDocs style)
  await loadPromptsFromServer();
  
  // Clear all previous activity logs - start fresh
  const debugLog = document.getElementById('debug-log');
  if (debugLog) {
    debugLog.textContent = '';
  }
  const errorCount = document.getElementById('debug-error-count');
  if (errorCount) {
    errorCount.textContent = '0';
  }
  
  addDebugLog('🚀 Page loaded - initializing TFS Agent Hub');
  
  // Initialize LLM provider (Azure by default)
  selectProvider('azure');

  const modelInput = document.getElementById('llm-model-override');
  if (modelInput) {
    modelInput.addEventListener('input', onModelOverrideInput);
  }
  
  // Load saved config
  checkHealth();
  loadLLMConfig();
  loadTFSConfig();
  
  // Check if configs are already saved from this browser session
  const savedTFS = sessionStorage.getItem('tfs_config');
  const savedLLM = sessionStorage.getItem('llm_config');
  if (savedTFS) {
    tfsConnected = true;
    const tfsDot = document.getElementById('tfs-dot');
    if (tfsDot) tfsDot.style.background = '#10b981';
    addDebugLog('✅ TFS configuration restored from session');
    
    // Auto-fetch test plans and dashboard queries on page load if config exists
    setTimeout(() => {
      addDebugLog('🔄 Auto-fetching test plans from saved config...');
      fetchAvailablePlans();
      dashLoadQueries();
    }, 500);
  }
  if (savedLLM) {
    llmConnected = true;
    const llmDot = document.getElementById('llm-dot');
    if (llmDot) llmDot.style.background = '#10b981';
    addDebugLog('✅ AI configuration restored from session');
  }
  setSuiteRefreshButtonState(false, false);
  updateConfigurationStatus();
});

function checkHealth() {
  const healthStatus = document.getElementById('health-status');
  const healthEmoji = document.getElementById('health-emoji');
  if (!healthStatus) return;
  
  healthStatus.textContent = 'Checking...';
  addDebugLog('🔍 System health check started');
  
  fetch(`${API_BASE}/health`)
    .then(r => r.json())
    .then(data => {
      healthStatus.textContent = 'Ready';
      if (healthEmoji) healthEmoji.textContent = '💚';
      addDebugLog('✅ System health: Ready');
    })
    .catch(err => {
      healthStatus.textContent = 'Offline';
      if (healthEmoji) healthEmoji.textContent = '❌';
      addDebugLog('⚠️ System health check timeout');
    });
}

// ==================== Helper Functions ====================

function getErrorMessage(data) {
  // Safely extract error message from API response
  if (typeof data === 'string') return data;
  if (typeof data === 'object' && data !== null) {
    if (data.message) return typeof data.message === 'string' ? data.message : JSON.stringify(data.message);
    if (data.detail) return typeof data.detail === 'string' ? data.detail : JSON.stringify(data.detail);
    if (data.error) return typeof data.error === 'string' ? data.error : JSON.stringify(data.error);
    return JSON.stringify(data);
  }
  return 'Unknown error';
}

// ==================== TFS Modal ====================

function closeAllTopModals(exceptId = null) {
  ['tfs-modal', 'llm-modal', 'guide-modal'].forEach((id) => {
    if (id === exceptId) return;
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  });
}

function openTFSModal() {
  closeAllTopModals('tfs-modal');
  const modal = document.getElementById('tfs-modal');
  if (modal) {
    modal.style.display = 'flex';
    addDebugLog('📂 TFS Configuration modal opened');
  }
}

function closeTFSModal() {
  const modal = document.getElementById('tfs-modal');
  if (modal) {
    modal.style.display = 'none';
    addDebugLog('📂 TFS Configuration modal closed');
  }
}

function closeTFSIfOutside(event) {
  if (event.target.id === 'tfs-modal') {
    closeTFSModal();
  }
}

async function testTFSConnection() {
  const baseUrl = document.getElementById('tfs-base-url');
  const username = document.getElementById('tfs-username');
  const password = document.getElementById('tfs-password');
  const patToken = document.getElementById('tfs-pat-token');
  const statusEl = document.getElementById('tfs-status');

  if (!baseUrl) {
    console.error('TFS config fields missing');
    return;
  }

  // Validate that either (username AND password) OR patToken is provided
  const hasBasicAuth = username?.value && password?.value;
  const hasPAT = patToken?.value;
  
  if (!hasBasicAuth && !hasPAT) {
    if (statusEl) {
      statusEl.style.display = 'block';
      statusEl.textContent = '❌ Please provide either Username/Password OR PAT Token';
      statusEl.style.background = '#ffcdd2';
      statusEl.style.color = '#c62828';
    }
    addDebugLog('❌ Authentication required: Username/Password or PAT Token');
    return;
  }

  if (statusEl) {
    statusEl.style.display = 'block';
    statusEl.textContent = 'Testing connection...';
    statusEl.style.background = '#e3f2fd';
    statusEl.style.color = '#1565c0';
  }

  try {
    const response = await fetch(`${API_BASE}/tfs/authenticate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        base_url: baseUrl.value,
        username: username?.value || '',
        password: password?.value || '',
        pat_token: patToken ? patToken.value : '',
        task_url: (document.getElementById('tfs-task-url')?.value || '').trim(),
        test_plan_url: (document.getElementById('tfs-test-plan-url')?.value || '').trim()
      })
    });

    const data = await response.json();
    if (response.ok && data.success !== false) {
      if (statusEl) {
        statusEl.style.background = '#c8e6c9';
        statusEl.style.color = '#2e7d32';
        statusEl.textContent = data.message || 'TFS connection successful';
      }
      addDebugLog('✅ TFS connection test passed');
    } else {
      const errorMsg = getErrorMessage(data);
      if (statusEl) {
        statusEl.style.background = '#ffcdd2';
        statusEl.style.color = '#c62828';
        statusEl.textContent = errorMsg || 'Connection failed';
      }
      addDebugLog(`❌ TFS connection test failed: ${errorMsg}`);
    }
  } catch (error) {
    if (statusEl) {
      statusEl.style.background = '#ffcdd2';
      statusEl.style.color = '#c62828';
      statusEl.textContent = '❌ Error: ' + error.message;
    }
    addDebugLog(`❌ TFS test error: ${error.message}`);
  }
}

async function testTFSCreatePermission() {
  const baseUrl = document.getElementById('tfs-base-url');
  const username = document.getElementById('tfs-username');
  const password = document.getElementById('tfs-password');
  const patToken = document.getElementById('tfs-pat-token');
  const statusEl = document.getElementById('tfs-status');

  // Validate that either (username AND password) OR patToken is provided
  const hasBasicAuth = username?.value && password?.value;
  const hasPAT = patToken?.value;
  
  if (!baseUrl || (!hasBasicAuth && !hasPAT)) {
    if (statusEl) {
      statusEl.style.display = 'block';
      statusEl.textContent = '⚠️ Please configure Base URL and provide either Username/Password OR PAT Token';
      statusEl.style.background = '#fff3cd';
      statusEl.style.color = '#856404';
    }
    console.error('TFS config fields missing');
    return;
  }

  if (statusEl) {
    statusEl.style.display = 'block';
    statusEl.textContent = 'Testing create permission...';
    statusEl.style.background = '#e3f2fd';
    statusEl.style.color = '#1565c0';
  }

  try {
    const response = await fetch(`${API_BASE}/tfs/test-create-permission`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        base_url: baseUrl.value,
        username: username?.value || '',
        password: password?.value || '',
        pat_token: patToken ? patToken.value : '',
        task_url: (document.getElementById('tfs-task-url')?.value || '').trim(),
        test_plan_url: (document.getElementById('tfs-test-plan-url')?.value || '').trim()
      })
    });

    const data = await response.json();
    if (response.ok && data.success) {
      if (statusEl) {
        statusEl.style.background = '#c8e6c9';
        statusEl.style.color = '#2e7d32';
        statusEl.textContent = '✅ ' + (data.message || 'Create permission available');
      }
      addDebugLog(`✅ Create permission test passed (${data.can_create ? 'can_create=true' : 'can_create=false'})`);
    } else {
      const errorMsg = getErrorMessage(data);
      if (statusEl) {
        statusEl.style.background = '#ffcdd2';
        statusEl.style.color = '#c62828';
        statusEl.textContent = '❌ ' + (errorMsg || 'Create permission test failed');
      }
      addDebugLog(`❌ Create permission test failed: ${errorMsg}`);
    }
  } catch (error) {
    if (statusEl) {
      statusEl.style.background = '#ffcdd2';
      statusEl.style.color = '#c62828';
      statusEl.textContent = '❌ Error: ' + error.message;
    }
    addDebugLog(`❌ Create permission test error: ${error.message}`);
  }
}

async function testTFSConnectionComplete() {
  // Just test authentication — no write permission probe needed
  await testTFSConnection();
}

async function fetchIterationPath() {
  const baseUrl = document.getElementById('tfs-base-url');
  const username = document.getElementById('tfs-username');
  const password = document.getElementById('tfs-password');
  const patToken = document.getElementById('tfs-pat-token');
  const statusEl = document.getElementById('tfs-status');
  const iterDisplay = document.getElementById('tfs-iteration-display');
  const iterValue = document.getElementById('tfs-iteration-display-value');
  
  if (!baseUrl || !username || !password) return;

  if (statusEl) {
    statusEl.style.display = 'block';
    statusEl.textContent = '⏳ Fetching iteration...';
  }

  try {
    const response = await fetch(`${API_BASE}/tfs/fetch-iteration`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        base_url: baseUrl.value,
        username: username.value,
        password: password.value,
        pat_token: patToken ? patToken.value : ''
      })
    });

    const data = await response.json();
    
    if (response.ok) {
      if (iterValue) iterValue.textContent = data.iteration_path;
      if (iterDisplay) iterDisplay.style.display = 'block';
      if (statusEl) {
        statusEl.style.background = '#c8e6c9';
        statusEl.style.color = '#2e7d32';
        statusEl.textContent = '✅ Iteration fetched successfully';
      }
      console.log('Iteration fetched:', data.iteration_path);
    } else {
      if (statusEl) {
        statusEl.style.background = '#ffcdd2';
        statusEl.style.color = '#c62828';
        statusEl.textContent = '❌ ' + (data.detail || 'Failed to fetch iteration');
      }
    }
  } catch (error) {
    if (statusEl) {
      statusEl.style.background = '#ffcdd2';
      statusEl.style.color = '#c62828';
      statusEl.textContent = '❌ Error: ' + error.message;
    }
    console.error('Iteration fetch error:', error);
  }
}

async function saveTFSConnection() {
  const baseUrl = document.getElementById('tfs-base-url');
  const username = document.getElementById('tfs-username');
  const password = document.getElementById('tfs-password');
  const patToken = document.getElementById('tfs-pat-token');
  const taskUrl = document.getElementById('tfs-task-url');
  const testPlanUrl = document.getElementById('tfs-test-plan-url');
  const statusEl = document.getElementById('tfs-status');
  
  if (!baseUrl || !taskUrl || !testPlanUrl) {
    if (statusEl) {
      statusEl.style.display = 'block';
      statusEl.textContent = '❌ Please fill in all required fields: Base URL, Task URL, and Test Plan URL';
      statusEl.style.background = '#ffcdd2';
      statusEl.style.color = '#c62828';
    }
    return;
  }

  if (statusEl) {
    statusEl.style.display = 'block';
    statusEl.textContent = '⏳ Verifying connection...';
    statusEl.style.background = '#e3f2fd';
    statusEl.style.color = '#1565c0';
  }

  const config = {
    base_url: baseUrl.value,
    username: username.value,
    password: password.value,
    pat_token: patToken ? patToken.value : '',
    task_url: taskUrl.value,
    test_plan_url: testPlanUrl.value
  };

  try {
    const response = await fetch(`${API_BASE}/tfs/authenticate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config)
    });
    
    const result = await response.json();
    if (result.success) {
      sessionStorage.setItem('tfs_config', JSON.stringify(config));
      clearPlanSuiteCache();
      tfsConnected = true;
      const dot = document.getElementById('tfs-dot');
      if (dot) dot.style.background = '#10b981';
      if (statusEl) {
        statusEl.style.background = '#c8e6c9';
        statusEl.style.color = '#2e7d32';
        statusEl.textContent = '✅ TFS Connection Verified & Saved';
      }
      showToast('✅ TFS Connection Verified');
      fetchAvailablePlans();
      dashLoadQueries();
      setTimeout(() => { document.getElementById('tfs-modal').style.display = 'none'; }, 1000);
      updateConfigurationStatus();
    } else {
      throw new Error(result.message || 'Authentication failed');
    }
  } catch (error) {
    if (statusEl) {
      statusEl.style.background = '#ffcdd2';
      statusEl.style.color = '#c62828';
      statusEl.textContent = '❌ ' + error.message;
    }
    addDebugLog(`❌ TFS Auth Failed: ${error.message}`);
  }
}

function loadTFSConfig() {
  const saved = sessionStorage.getItem('tfs_config');
  if (saved) {
    try {
      const config = JSON.parse(saved);
      
      // Restore form fields but DON'T set tfsConnected to true
      // User must click Save again to confirm configuration
      
      const baseUrl = document.getElementById('tfs-base-url');
      const username = document.getElementById('tfs-username');
      const password = document.getElementById('tfs-password');
      const patToken = document.getElementById('tfs-pat-token');
      const taskUrl = document.getElementById('tfs-task-url');
      const testPlanUrl = document.getElementById('tfs-test-plan-url');
      
      if (baseUrl) baseUrl.value = config.base_url || '';
      if (username) username.value = config.username || '';
      if (password) password.value = config.password || '';
      if (patToken) patToken.value = config.pat_token || '';
      if (taskUrl) taskUrl.value = config.task_url || '';
      if (testPlanUrl) testPlanUrl.value = config.test_plan_url || '';
      
      // Populate lastTestCaseExecutionData so fetchAvailablePlans() can use it
      lastTestCaseExecutionData = {
        tfs_config: config,
        llm_config: lastTestCaseExecutionData?.llm_config || null
      };
      
      console.log('TFS form fields restored from session');
    } catch (error) {
      console.error('Error loading TFS config:', error);
    }
  }
}

// ==================== LLM Modal ====================

function openLLMModal() {
  closeAllTopModals('llm-modal');
  const modal = document.getElementById('llm-modal');
  if (modal) {
    modal.style.display = 'flex';
    addDebugLog('⚙️ AI Provider Configuration modal opened');
  }
}

function closeLLMModal() {
  const modal = document.getElementById('llm-modal');
  if (modal) {
    modal.style.display = 'none';
    addDebugLog('⚙️ AI Provider Configuration modal closed');
  }
}

// ==================== User Guide Modal ====================

function openGuideModal() {
  closeAllTopModals('guide-modal');
  const modal = document.getElementById('guide-modal');
  if (modal) {
    modal.style.display = 'flex';
    // Initialize to the setup tab
    switchHelpTab('setup', document.querySelector('.help-nav-item'));
    addDebugLog('📖 Documentation Dashboard opened');
  }
}

function closeGuideModal() {
  const modal = document.getElementById('guide-modal');
  if (modal) {
    modal.style.display = 'none';
    addDebugLog('📖 User Guide modal closed');
  }
}

// --- Help Portal Interactivity ---
function switchHelpTab(tabId, el) {
  // Hide all sections
  document.querySelectorAll('.help-content-section').forEach(s => s.style.display = 'none');
  // Deactivate all tabs
  document.querySelectorAll('.help-nav-item').forEach(t => t.classList.remove('active'));
  
  // Show selected section and activate tab
  const target = document.getElementById(`htab-${tabId}`);
  if (target) {
    target.style.display = 'block';
    // Update breadcrumb
    const breadcrumbEl = document.getElementById('breadcrumb-current');
    if (breadcrumbEl && el) {
      breadcrumbEl.textContent = el.textContent.replace(/[^\w\s#]/g, '').trim();
    }
  }
  if (el) el.classList.add('active');
}

function copyToClipboard(text) {
  navigator.clipboard.writeText(text).then(() => {
    showToast('Sample data copied to clipboard', 'info');
  });
}

function closeLLMIfOutside(event) {
  if (event.target.id === 'llm-modal') {
    closeLLMModal();
  }
}

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  const tfsOpen = document.getElementById('tfs-modal')?.style.display === 'flex';
  const llmOpen = document.getElementById('llm-modal')?.style.display === 'flex';
  const guideOpen = document.getElementById('guide-modal')?.style.display === 'flex';
  if (tfsOpen || llmOpen || guideOpen) {
    closeAllTopModals();
    addDebugLog('⌨️ Top modal closed using Esc');
  }
});

function selectProvider(provider) {
  const previousProvider = selectedProvider;
  cacheProviderApiKey(previousProvider);
  cacheProviderModelOverride(previousProvider);

  selectedProvider = provider;
  console.log('Provider selected:', provider);

  const providerSelect = document.getElementById('llm-provider-select');
  if (providerSelect) {
    providerSelect.value = provider;
  }

  const llmLabel = document.getElementById('llm-label');
  if (llmLabel) {
    const labelMap = {
      azure: 'Azure OpenAI',
      openai: 'OpenAI',
      claude: 'Claude',
      gemini: 'Google Gemini'
    };
    llmLabel.textContent = labelMap[provider] || 'AI Provider';
  }
  
  // Show/hide Azure fields
  const azureFields = document.getElementById('azure-fields');
  if (azureFields) {
    azureFields.style.display = provider === 'azure' ? 'block' : 'none';
  }

  applyProviderApiKey(provider);
  applyProviderModelOverride(provider);
  persistProviderKeyMap();
  persistProviderModelMap();
}

function onKeyInput() {
  cacheProviderApiKey(selectedProvider);
}

function onModelOverrideInput() {
  cacheProviderModelOverride(selectedProvider);
}

function toggleAPIKeyVisibility() {
  const apiKeyInput = document.getElementById('llm-api-key');
  if (!apiKeyInput) return;
  
  if (apiKeyInput.type === 'password') {
    apiKeyInput.type = 'text';
  } else {
    apiKeyInput.type = 'password';
  }
}

async function testLLMConnection() {
  const apiKey = document.getElementById('llm-api-key');
  const statusEl = document.getElementById('config-status');
  
  if (!apiKey || !apiKey.value) {
    if (statusEl) {
      statusEl.style.display = 'block';
      statusEl.textContent = '❌ Please enter an API key';
    }
    return;
  }

  if (statusEl) {
    statusEl.style.display = 'block';
    statusEl.textContent = '⏳ Testing connection...';
    statusEl.style.background = '#e3f2fd';
  }

  try {
    // Simple test - just validate the key format
    if (selectedProvider === 'azure') {
      if (!apiKey.value.length) throw new Error('API Key is required');
    } else if (selectedProvider === 'openai') {
      if (!apiKey.value.startsWith('sk-')) {
        console.warn('OpenAI key should start with sk-');
      }
    }

    if (statusEl) {
      statusEl.style.background = '#c8e6c9';
      statusEl.textContent = '✅ Configuration appears valid';
    }
    console.log('LLM config test passed');
  } catch (error) {
    if (statusEl) {
      statusEl.style.background = '#ffcdd2';
      statusEl.textContent = '❌ ' + error.message;
    }
  }
}

async function saveLLMConfig() {
  const apiKey = document.getElementById('llm-api-key');
  const deployment = document.getElementById('azure-deployment');
  const endpoint = document.getElementById('azure-endpoint');
  const apiVersion = document.getElementById('azure-api-version');
  const modelOverride = document.getElementById('llm-model-override');
  const statusEl = document.getElementById('config-status');
  
  cacheProviderApiKey(selectedProvider);
  cacheProviderModelOverride(selectedProvider);
  persistProviderKeyMap();
  persistProviderModelMap();

  const currentApiKey = providerApiKeys[selectedProvider] || (apiKey ? apiKey.value : '');
  const currentModelOverride = providerModelOverrides[selectedProvider] || (modelOverride ? modelOverride.value : '');
  if (!currentApiKey) {
    addDebugLog('❌ API Key required for configuration');
    return;
  }

  if (statusEl) {
    statusEl.style.display = 'block';
    statusEl.textContent = '⏳ Verifying AI configuration...';
    statusEl.style.background = '#e3f2fd';
    statusEl.style.color = '#1565c0';
  }

  const config = {
    provider: selectedProvider,
    api_key: currentApiKey,
    provider_keys: providerApiKeys,
    provider_models: providerModelOverrides,
    deployment_name: deployment ? deployment.value : '',
    endpoint: endpoint ? endpoint.value : '',
    api_version: apiVersion ? apiVersion.value : '',
    model: currentModelOverride
  };

  try {
    const response = await fetch(`${API_BASE}/prompts/all`);
    if (response.ok) {
      sessionStorage.setItem('llm_config', JSON.stringify(config));
      sessionStorage.setItem('llm_provider_keys', JSON.stringify(providerApiKeys));
      sessionStorage.setItem('llm_provider_models', JSON.stringify(providerModelOverrides));
      llmConnected = true;
      const dot = document.getElementById('llm-dot');
      if (dot) dot.style.background = '#10b981';
      
      if (statusEl) {
        statusEl.style.background = '#c8e6c9';
        statusEl.style.color = '#2e7d32';
        statusEl.textContent = '✅ Configuration Verified & Saved';
      }
      
      showToast('✅ AI Provider Configured');
      setTimeout(() => { document.getElementById('llm-modal').style.display = 'none'; }, 1000);
      updateConfigurationStatus();
    } else {
      throw new Error('Verification failed');
    }
  } catch (error) {
    if (statusEl) {
      statusEl.style.background = '#ffcdd2';
      statusEl.style.color = '#c62828';
      statusEl.textContent = '❌ Verification failed: ' + error.message;
    }
  }
}

function clearLLMConfig() {
  sessionStorage.removeItem('llm_config');
  sessionStorage.removeItem('llm_provider_keys');
  sessionStorage.removeItem('llm_provider_models');
  providerApiKeys = {};
  providerModelOverrides = {};
  const apiKey = document.getElementById('llm-api-key');
  const modelOverride = document.getElementById('llm-model-override');
  if (apiKey) apiKey.value = '';
  if (modelOverride) modelOverride.value = '';
  console.log('LLM config cleared');
}

function loadLLMConfig() {
  const saved = sessionStorage.getItem('llm_config');
  if (saved) {
    try {
      const config = JSON.parse(saved);
      const savedProviderKeys = sessionStorage.getItem('llm_provider_keys');
      if (savedProviderKeys) {
        providerApiKeys = JSON.parse(savedProviderKeys) || {};
      } else if (config.provider_keys && typeof config.provider_keys === 'object') {
        providerApiKeys = config.provider_keys;
      } else {
        providerApiKeys = {};
      }
      const savedProviderModels = sessionStorage.getItem('llm_provider_models');
      if (savedProviderModels) {
        providerModelOverrides = JSON.parse(savedProviderModels) || {};
      } else if (config.provider_models && typeof config.provider_models === 'object') {
        providerModelOverrides = config.provider_models;
      } else {
        providerModelOverrides = {};
      }
      
      // Restore form fields but DON'T set llmConnected to true
      // User must click Save again to confirm configuration
      
      // Restore provider
      if (config.provider) {
        selectedProvider = config.provider;
        if (config.api_key && !providerApiKeys[config.provider]) {
          providerApiKeys[config.provider] = config.api_key;
        }
        if (config.model && !providerModelOverrides[config.provider]) {
          providerModelOverrides[config.provider] = config.model;
        }
        selectProvider(config.provider);
      }
      
      // Restore API key
      const apiKey = document.getElementById('llm-api-key');
      if (apiKey) apiKey.value = providerApiKeys[selectedProvider] || config.api_key || '';
      
      // Restore Azure fields
      const endpoint = document.getElementById('azure-endpoint');
      if (endpoint) endpoint.value = config.endpoint || '';
      
      const deployment = document.getElementById('azure-deployment');
      if (deployment) deployment.value = config.deployment_name || '';
      
      const apiVersion = document.getElementById('azure-api-version');
      if (apiVersion) apiVersion.value = config.api_version || '';
      
      // Restore model override
      const modelOverride = document.getElementById('llm-model-override');
      if (modelOverride) modelOverride.value = providerModelOverrides[selectedProvider] || config.model || '';
      
      console.log('LLM form fields restored from session');
    } catch (error) {
      console.error('Error loading LLM config:', error);
    }
  }
}

// ==================== Agent Selection ====================

function selectAgent(agentId, cardElement) {
  console.log('Agent selected:', agentId);
  let agentName = agentId === 'task-creation' ? 'Task Creation' : (agentId === 'bug-creation' ? 'Bug Creation' : (agentId === 'dashboard' ? 'Dashboard' : 'Test Case Generator'));
  addDebugLog(`🤖 Agent selected: ${agentName}`);
  
  currentAgent = agentId;
  
  // Update UI
  document.querySelectorAll('.agent-card').forEach(card => {
    card.style.background = '';
    card.style.borderColor = '';
  });
  
  if (cardElement) {
    cardElement.style.background = '#f0f9ff';
    cardElement.style.borderColor = '#0284c7';
  }
  
  // Enable continue button
  const continueBtn = document.getElementById('btn-continue');
  if (continueBtn) {
    continueBtn.disabled = false;
  }
}

function updateConfigurationStatus() {
  /**
   * Displays configuration status on Step 1 to guide users
   * to configure TFS and AI before proceeding
   */
  const tfsConfig = getEffectiveTFSConfig();
  const llmConfig = sessionStorage.getItem('llm_config');
  
  const hasTFS = tfsConfig && tfsConfig.base_url;
  const hasLLM = !!llmConfig;
  
  // Find or create a status container
  let statusContainer = document.getElementById('config-status-container');
  if (!statusContainer) {
    const agentSelectPanel = document.getElementById('panel-agent-select');
    if (agentSelectPanel) {
      statusContainer = document.createElement('div');
      statusContainer.id = 'config-status-container';
      statusContainer.style.cssText = 'background:#fffbeb;border:1px solid #fbbf24;border-radius:6px;padding:8px 12px;margin-bottom:12px;font-size:0.9rem;color:#78350f;line-height:1.4;';
      agentSelectPanel.insertBefore(statusContainer, agentSelectPanel.firstChild);
    }
  }
  
  if (statusContainer) {
    const tfsStatus = hasTFS ? '✅ TFS' : '❌ TFS';
    const llmStatus = hasLLM ? '✅ AI' : '❌ AI';
    
    let statusHTML = `⚙️ Configuration Status: <strong>${tfsStatus}</strong> | <strong>${llmStatus}</strong>`;
    
    if (!hasTFS || !hasLLM) {
      const missing = [];
      if (!hasTFS) missing.push('TFS');
      if (!hasLLM) missing.push('AI');
      statusHTML += ` <span style="margin-left:8px;">⚠️ Configure ${missing.join(', ')} in Step 0</span>`;
    }
    
    statusContainer.innerHTML = statusHTML;
    statusContainer.style.display = 'block';
  }
}

function continueToConfig() {
  if (!currentAgent) {
    addDebugLog('❌ No agent selected');
    console.warn('No agent selected');
    return;
  }
  
  // Check if TFS configuration is set
  const tfsConfig = getEffectiveTFSConfig();
  if (!tfsConfig.base_url) {
    addDebugLog('❌ Please configure TFS first (Base URL required). Go to Step 1.');
    alert('⚠️ TFS Configuration Required\n\nPlease configure TFS (Base URL) in Step 1 before proceeding.');
    return;
  }
  
  // Check if LLM/AI configuration is set
  const llmConfig = sessionStorage.getItem('llm_config');
  if (!llmConfig) {
    addDebugLog('❌ Please configure AI (LLM) first. Go to Step 1.');
    alert('⚠️ AI Configuration Required\n\nPlease configure AI (LLM Provider) in Step 1 before proceeding.');
    return;
  }
  
  // Both configurations are present, proceed
  populateConfigForm(currentAgent);
  addDebugLog(`📋 Moving to configuration step for ${currentAgent}`);
  
  // Show config panel
  showPanel('panel-config');
  updateStepIndicator(2);
  console.log('Moving to configuration step for:', currentAgent);
}

function populateConfigForm(agentId) {
  const configForm = document.getElementById('config-form');
  const configTitle = document.getElementById('config-title');
  const configDesc = document.getElementById('config-description');
  
  if (!configForm) return;
  
  configForm.innerHTML = '';

  if (agentId === 'task-creation') {
    configTitle.textContent = 'Step 2: Task Creation Configuration';
    configDesc.textContent = '— Enter task description or upload Excel file for bulk creation';
    
    configForm.innerHTML = `
      <div class="config-row">
        <label style="font-size:var(--fs-sm);font-weight:var(--fw-semibold);color:var(--ink);margin-bottom:10px;display:block;">📋 Bulk Operation Mode:</label>
        <div style="display:flex;gap:16px;margin-bottom:20px;">
          <div style="display:flex;align-items:center;gap:8px;">
            <input type="radio" id="mode-create-excel" name="bulk-mode" value="create" checked style="width:16px;height:16px;cursor:pointer;" />
            <label for="mode-create-excel" style="cursor:pointer;font-size:0.95rem;color:var(--ink);">
              ➕ Create (New Tasks)
            </label>
          </div>
          <div style="display:flex;align-items:center;gap:8px;">
            <input type="radio" id="mode-update-excel" name="bulk-mode" value="update" style="width:16px;height:16px;cursor:pointer;" />
            <label for="mode-update-excel" style="cursor:pointer;font-size:0.95rem;color:var(--ink);">
              ✏️ Update (Existing Tasks)
            </label>
          </div>
        </div>
      </div>

      <div class="config-row">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
          <label style="font-size:var(--fs-sm);font-weight:var(--fw-semibold);color:var(--ink);margin:0;">Iteration Path</label>
          <span onclick="fetchIterationPathStep2(false)" title="Refresh Iteration Path" style="cursor:pointer;font-weight:bold;color:#b45309;font-size:1rem;padding:0 4px;">↻</span>
        </div>
        <div style="position:relative;">
          <input class="config-input" id="iteration-path" type="text" placeholder="Start typing or click to select..." 
                 style="flex:1;height:32px;padding:4px 8px;font-size:0.9rem;width:100%;" 
                 onfocus="showIterationDropdown()" 
                 onmousedown="showIterationDropdown()"
                 onblur="hideIterationDropdown()"
                 oninput="filterIterationDropdown(this.value); cacheIterationPath(this.value);" />
          <div id="iteration-dropdown" style="display:none;position:absolute;top:100%;left:0;right:0;background:white;border:1px solid #ddd;border-top:none;max-height:200px;overflow-y:auto;z-index:1000;box-shadow:0 4px 6px rgba(0,0,0,0.1);">
            <div id="iteration-list" style="padding:4px;"></div>
          </div>
        </div>
      </div>
      
      <div style="height:1px;background:#e0e0e0;margin:20px 0;"></div>
      
      <div style="margin-bottom:16px;">
        <label style="font-size:var(--fs-sm);font-weight:var(--fw-semibold);color:var(--ink);margin-bottom:8px;display:block;">Choose Input Method:</label>
        <div style="display:flex;gap:8px;">
          <button class="input-method-btn active" id="method-excel" onclick="switchInputMethod('excel')" style="flex:1;padding:8px;border:2px solid #0066cc;background:#f0f9ff;border-radius:6px;cursor:pointer;font-weight:600;font-size:0.9rem;">📊 Excel</button>
          <button class="input-method-btn" id="method-onedrive" onclick="switchInputMethod('onedrive')" style="flex:1;padding:8px;border:2px solid #ddd;background:white;border-radius:6px;cursor:pointer;font-weight:600;font-size:0.9rem;">☁️ OneDrive</button>
          <button class="input-method-btn" id="method-gdrive" onclick="switchInputMethod('gdrive')" style="flex:1;padding:8px;border:2px solid #ddd;background:white;border-radius:6px;cursor:pointer;font-weight:600;font-size:0.9rem;">📁 Google Drive</button>
        </div>
      </div>
      
      <div style="height:1px;background:#e0e0e0;margin:20px 0;"></div>
      
      <div id="section-excel" class="input-section">
        <div class="config-row">
          <label for="excel-file" style="font-size:var(--fs-sm);font-weight:var(--fw-semibold);color:var(--ink);">Upload Excel File</label>
          <input class="config-input" id="excel-file" type="file" accept=".xlsx,.xls,.csv" style="height:32px;padding:3px 8px;font-size:0.9rem;" onchange="autoLoadExcelSheet()" />
          <small style="color:#666;margin-top:4px;font-size:0.85rem;">Supported: .xlsx, .xls, .csv (sheet loads automatically)</small>
        </div>
        <div class="config-row">
          <div id="excel-status" style="margin-top:6px;font-size:0.85rem;color:#374151;"></div>
        </div>
        <div class="config-row" id="excel-sheet-picker" style="display:none;">
          <label for="excel-sheet-select" style="font-size:var(--fs-sm);font-weight:var(--fw-semibold);color:var(--ink);display:block;margin-bottom:6px;">Multiple Sheets Found - Select One:</label>
          <select class="config-input" id="excel-sheet-select" onchange="syncLocalSheetSelection()" style="height:32px;padding:4px 8px;font-size:0.9rem;"></select>
          <input class="config-input" id="sheet-name" type="hidden" />
        </div>
      </div>
      
      <div id="section-onedrive" class="input-section" style="display:none;">
        <div class="config-row">
          <label for="onedrive-url" style="font-size:var(--fs-sm);font-weight:var(--fw-semibold);color:var(--ink);">OneDrive Share Link</label>
          <input class="config-input" id="onedrive-url" type="url" placeholder="Paste OneDrive sharing link here" style="height:36px;padding:6px 10px;" />
          <small style="color:#666;margin-top:6px;">Get link by right-click -> Share on OneDrive</small>
        </div>
        <div class="config-row">
          <label for="onedrive-token" style="font-size:var(--fs-sm);font-weight:var(--fw-semibold);color:var(--ink);">OneDrive Access Token (Optional)</label>
          <input class="config-input" id="onedrive-token" type="password" placeholder="Paste bearer token if link is private" style="height:36px;padding:6px 10px;" />
        </div>
        <div class="config-row">
          <button onclick="validateDriveLink('onedrive')" style="padding:8px 16px;background:#0066cc;color:white;border:none;border-radius:6px;cursor:pointer;font-size:0.9rem;white-space:nowrap;">Check Access and Load Sheets</button>
          <div id="onedrive-status" style="margin-top:8px;font-size:0.9rem;color:#374151;"></div>
        </div>
        <div class="config-row" id="onedrive-sheet-picker" style="display:none;">
          <div style="display:flex;gap:10px;align-items:flex-end;">
            <div style="flex:1;">
              <label for="onedrive-sheet-select" style="font-size:var(--fs-sm);font-weight:var(--fw-semibold);color:var(--ink);display:block;margin-bottom:6px;">Available Sheets</label>
              <select class="config-input" id="onedrive-sheet-select" onchange="syncSheetSelection('onedrive')" style="height:36px;padding:6px 10px;"></select>
            </div>
            <div style="flex:1;">
              <label for="onedrive-sheet" style="font-size:var(--fs-sm);font-weight:var(--fw-semibold);color:var(--ink);display:block;margin-bottom:6px;">Sheet Name</label>
              <input class="config-input" id="onedrive-sheet" type="text" placeholder="e.g., Tasks" style="height:36px;padding:6px 10px;" />
            </div>
          </div>
        </div>
        <div class="config-row" id="onedrive-sheet-manual">
          <label for="onedrive-sheet-manual-input" style="font-size:var(--fs-sm);font-weight:var(--fw-semibold);color:var(--ink);">Sheet Name</label>
          <input class="config-input" id="onedrive-sheet-manual-input" type="text" placeholder="e.g., Tasks (or load sheets first)" style="height:36px;padding:6px 10px;" oninput="syncProviderManualSheet('onedrive')" />
        </div>
      </div>
      
      <div id="section-gdrive" class="input-section" style="display:none;">
        <div class="config-row">
          <label for="gdrive-url" style="font-size:var(--fs-sm);font-weight:var(--fw-semibold);color:var(--ink);">Google Drive Share Link</label>
          <input class="config-input" id="gdrive-url" type="url" placeholder="Paste Google Drive/Sheets link here" style="height:36px;padding:6px 10px;" />
          <small style="color:#666;margin-top:6px;">Get link by Share button on Google Sheets</small>
        </div>
        <div class="config-row">
          <label for="gdrive-token" style="font-size:var(--fs-sm);font-weight:var(--fw-semibold);color:var(--ink);">Google Access Token (Optional)</label>
          <input class="config-input" id="gdrive-token" type="password" placeholder="Paste bearer token if link is private" style="height:36px;padding:6px 10px;" />
        </div>
        <div class="config-row">
          <button onclick="validateDriveLink('gdrive')" style="padding:8px 16px;background:#0066cc;color:white;border:none;border-radius:6px;cursor:pointer;font-size:0.9rem;white-space:nowrap;">Check Access and Load Sheets</button>
          <div id="gdrive-status" style="margin-top:8px;font-size:0.9rem;color:#374151;"></div>
        </div>
        <div class="config-row" id="gdrive-sheet-picker" style="display:none;">
          <div style="display:flex;gap:10px;align-items:flex-end;">
            <div style="flex:1;">
              <label for="gdrive-sheet-select" style="font-size:var(--fs-sm);font-weight:var(--fw-semibold);color:var(--ink);display:block;margin-bottom:6px;">Available Sheets</label>
              <select class="config-input" id="gdrive-sheet-select" onchange="syncSheetSelection('gdrive')" style="height:36px;padding:6px 10px;"></select>
            </div>
            <div style="flex:1;">
              <label for="gdrive-sheet" style="font-size:var(--fs-sm);font-weight:var(--fw-semibold);color:var(--ink);display:block;margin-bottom:6px;">Sheet Name</label>
              <input class="config-input" id="gdrive-sheet" type="text" placeholder="e.g., Tasks" style="height:36px;padding:6px 10px;" />
            </div>
          </div>
        </div>
        <div class="config-row" id="gdrive-sheet-manual">
          <label for="gdrive-sheet-manual-input" style="font-size:var(--fs-sm);font-weight:var(--fw-semibold);color:var(--ink);">Sheet Name</label>
          <input class="config-input" id="gdrive-sheet-manual-input" type="text" placeholder="e.g., Tasks (or load sheets first)" style="height:36px;padding:6px 10px;" oninput="syncProviderManualSheet('gdrive')" />
        </div>
      </div>
    `;
    
    // [AGENT 1] Auto-fetch iteration path after DOM is ready
    addDebugLog('🔄 Task agent config loaded, auto-fetching iteration path...');
    setTimeout(() => fetchIterationPathStep2(true), 200);
    
  } else if (agentId === 'test-case') {
    configTitle.textContent = 'Step 2: Test Case Generation Configuration';
    configDesc.textContent = '— Configure test case generation parameters';
    
    configForm.innerHTML = `
      <div class="config-row">
        <label for="work-item-id" style="font-size:var(--fs-sm);font-weight:var(--fw-semibold);color:var(--ink);">User Story ID</label>
        <div style="display:flex;gap:10px;align-items:center;position:relative;">
          <input class="config-input" id="work-item-id" type="text" placeholder="Enter ID or select from list..." style="height:38px;flex:1;" 
                 onfocus="showUserStoryDropdownStep2()" 
                 onmousedown="showUserStoryDropdownStep2()"
                 onblur="hideUserStoryDropdownStep2()"
                 oninput="filterUserStoryDropdownStep2(this.value)" />
          <div id="user-story-dropdown" style="display:none;position:absolute;top:100%;left:0;right:100px;background:white;border:1px solid #ddd;max-height:250px;overflow-y:auto;z-index:1000;box-shadow:0 4px 12px rgba(0,0,0,0.15);border-radius:0 0 8px 8px;">
            <div id="user-story-list" style="padding:4px;"></div>
          </div>
          <button onclick="fetchUserStoryDetailsStep2()" style="padding:8px 14px;background:#0b4f8a;color:white;border:none;border-radius:6px;cursor:pointer;white-space:nowrap;width:80px;">Fetch</button>
        </div>
      </div>

      <div class="config-row">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">
          <label for="story-preview" style="font-size:var(--fs-sm);font-weight:var(--fw-semibold);color:var(--ink);margin:0;">User Story Details (Edit or Leave Empty)</label>
          <button id="btn-analyze-story" onclick="analyzeUserStory()" style="padding:6px 14px;background:#e0f2fe;color:#0f172a;border:1px solid #bae6fd;border-radius:6px;cursor:pointer;font-size:12px;font-weight:700;white-space:nowrap;display:flex;align-items:center;gap:6px;transition:all 0.2s;">🔍 Analyze User Story</button>
        </div>
        <div style="position:relative;">
          <textarea class="config-input" id="story-preview" placeholder="Details will auto-load when you click 'Fetch' above. Or enter/edit your own story here: Title: ..., Description: ..., Acceptance Criteria: ..." style="min-height:120px;background:#ffffff;padding-right:40px;"></textarea>
          <button onclick="openLargeEditor('story-preview', 'User Story Details Editor')" style="position:absolute;right:10px;top:10px;background:none;border:none;font-size:18px;cursor:pointer;color:#0f766e;opacity:0.6;transition:opacity 0.2s;z-index:2;padding:0;" onmouseover="this.style.opacity='1'" onmouseout="this.style.opacity='0.6'" title="Fullscreen Editor">⤢</button>
        </div>
        <small style="color:#666;margin-top:4px;font-size:0.85rem;">Auto-populated from TFS or enter manually</small>
        <div id="story-analysis-result" style="display:none;margin-top:10px;padding:12px;background:#f0fdfa;border:1px solid #ccfbf1;border-radius:8px;font-size:0.87rem;line-height:1.55;white-space:pre-wrap;color:#0f766e;font-weight:600;"></div>
        </div>

        <div class="config-row">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">
          <label for="sop-text" style="font-size:var(--fs-sm);font-weight:var(--fw-semibold);color:var(--ink);margin:0;">SOP (TruDocs default, editable)</label>
          <button onclick="loadDefaultSOPStep2(true)" style="padding:6px 10px;background:#e0f2fe;color:#0f172a;border:1px solid #bae6fd;border-radius:6px;cursor:pointer;font-size:12px;">Use Default SOP</button>
        </div>
        <div style="position:relative;">
          <textarea class="config-input" id="sop-text" placeholder="SOP text will auto-load; you can edit before run." style="min-height:150px;padding-right:40px;"></textarea>
          <button onclick="openLargeEditor('sop-text', 'SOP Editor')" style="position:absolute;right:10px;top:10px;background:none;border:none;font-size:18px;cursor:pointer;color:#0f766e;opacity:0.6;transition:opacity 0.2s;z-index:2;padding:0;" onmouseover="this.style.opacity='1'" onmouseout="this.style.opacity='0.6'" title="Fullscreen Editor">⤢</button>
        </div>      </div>

      <div class="config-row">
        <label for="testcase-mode" style="font-size:var(--fs-sm);font-weight:var(--fw-semibold);color:var(--ink);">Test Type</label>
        <select class="config-input" id="testcase-mode" onchange="onTestModeChangeStep2()">
          <option value="functional">Functional Test Cases</option>
          <option value="ui">UI Test Cases</option>
          <option value="both">Both (Functional + UI)</option>
        </select>
      </div>

      <div class="config-row" id="functional-prompt-row">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">
          <label for="functional-prompt" style="font-size:var(--fs-sm);font-weight:var(--fw-semibold);color:var(--ink);margin:0;">Functional Prompt</label>
          <button onclick="setDefaultPromptStep2('functional')" style="padding:6px 10px;background:#f1f5f9;color:#0f172a;border:1px solid #cbd5e1;border-radius:6px;cursor:pointer;font-size:12px;">Use Default</button>
        </div>
        <div style="position:relative;">
          <textarea class="config-input" id="functional-prompt" style="min-height:110px;padding-right:40px;" placeholder="Functional prompt"></textarea>
          <button onclick="openLargeEditor('functional-prompt', 'Functional Prompt Editor')" style="position:absolute;right:35px;top:8px;background:none;border:none;font-size:18px;cursor:pointer;color:#0f766e;opacity:0.6;transition:opacity 0.2s;" onmouseover="this.style.opacity='1'" onmouseout="this.style.opacity='0.6'" title="Fullscreen Editor">⤢</button>
        </div>
      </div>

      <div class="config-row" id="ui-prompt-row" style="display:none;">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">
          <label for="ui-prompt" style="font-size:var(--fs-sm);font-weight:var(--fw-semibold);color:var(--ink);margin:0;">UI Prompt</label>
          <button onclick="setDefaultPromptStep2('ui')" style="padding:6px 10px;background:#f1f5f9;color:#0f172a;border:1px solid #cbd5e1;border-radius:6px;cursor:pointer;font-size:12px;">Use Default</button>
        </div>
        <div style="position:relative;">
          <textarea class="config-input" id="ui-prompt" style="min-height:110px;padding-right:40px;" placeholder="UI prompt"></textarea>
          <button onclick="openLargeEditor('ui-prompt', 'UI Prompt Editor')" style="position:absolute;right:35px;top:8px;background:none;border:none;font-size:18px;cursor:pointer;color:#0f766e;opacity:0.6;transition:opacity 0.2s;" onmouseover="this.style.opacity='1'" onmouseout="this.style.opacity='0.6'" title="Fullscreen Editor">⤢</button>
        </div>
      </div>

      <div class="config-row" id="ui-screenshot-row" style="display:none;">
        <label for="ui-screenshot" style="font-size:var(--fs-sm);font-weight:var(--fw-semibold);color:var(--ink);">UI Screenshots (for UI mode)</label>
        <input class="config-input" id="ui-screenshot" type="file" accept="image/*" multiple onchange="onUIScreenshotFilesSelected()" />
        <div id="ui-screenshot-file-actions" style="display:none;margin-top:8px;justify-content:flex-end;">
          <button onclick="clearUIScreenshotFiles()" style="padding:6px 10px;background:#fff1f2;color:#b91c1c;border:1px solid #fecdd3;border-radius:6px;cursor:pointer;font-size:12px;">Clear All</button>
        </div>
        <div id="ui-screenshot-file-list" style="margin-top:8px;display:none;"></div>
        <small style="color:#64748b;">Optional: Upload one or more UI screenshots to guide test generation.</small>
      </div>
      
      <div class="config-row">
        <label style="display:flex;align-items:center;gap:8px;">
          <input type="checkbox" id="coverage-analysis" />
          <span style="font-size:var(--fs-sm);">Enable Coverage Analysis</span>
        </label>
      </div>
    `;

    // [AGENT 2] Auto-fetch user stories for dropdown
    addDebugLog('🔄 Test case agent config loaded, auto-fetching user stories...');
    requestAnimationFrame(() => {
      fetchUserStoriesForDropdownStep2();
    });

  } else if (agentId === 'bug-creation') {
    configTitle.textContent = 'Step 2: Bug, Feature & User Story Agent';
    configDesc.textContent = '— Describe via Chat → AI Structures → Refine & Create';
    
    configForm.style.padding = '0';
    configForm.style.background = 'transparent';
    configForm.style.border = 'none';

    configForm.innerHTML = `
      <div class="bug-agent-container" style="height: auto; min-height: 550px; overflow: visible; display: flex; flex-wrap: wrap;">
        <!-- Left: AI Chatbot Side -->
        <div class="bug-chat-pane" style="height: auto; min-height: 550px; flex: 1; min-width: 350px; display: flex; flex-direction: column;">
          <div class="chat-messages" id="bug-chat-messages" style="flex: 1; min-height: 350px; max-height: 450px; overflow-y: auto;">
            <div class="chat-bubble ai">
              Hello! Describe a ${bugAgentState.wiType === 'Bug' ? 'bug' : 'new feature'}, and I'll structure it for TFS. Screenshots are supported!
            </div>
          </div>
          <div class="chat-input-area-modern">
            <div id="chat-screenshot-preview-container" style="display:none; position:relative; margin-bottom:12px;">
                <img id="chat-screenshot-preview" src="" style="max-height:100px; border-radius:10px; border:1.5px solid #e2e8f0; box-shadow: var(--shadow-sm);" />
                <button onclick="clearChatScreenshot()" style="position:absolute; top:-8px; right:-8px; background:#ef4444; color:white; border:none; border-radius:50%; width:22px; height:22px; cursor:pointer; font-size:12px; display:flex; align-items:center; justify-content:center; box-shadow:0 2px 4px rgba(0,0,0,0.1);">✕</button>
            </div>
            <div class="chat-input-wrapper">
              <label for="bug-screenshot-upload" class="chat-attach-btn" title="Attach Screenshot">
                  <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>
                  <input type="file" id="bug-screenshot-upload" accept="image/*" style="display:none;" onchange="handleChatScreenshotUpload(this)" multiple />
              </label>
              <textarea id="bug-chat-input" class="chat-input-field" placeholder="Type your message..." rows="1" oninput="this.style.height='auto'; this.style.height=Math.min(this.scrollHeight, 120)+'px'"></textarea>
              <button onclick="sendChatMessage()" id="btn-send-chat" class="chat-send-btn" title="Send Message">
                <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>
              </button>
            </div>
          </div>
        </div>

        <!-- Right: TFS Form Side -->
        <div class="bug-form-pane" id="bug-form-scroll-pane" style="overflow: visible; height: auto; flex: 1.4; min-width: 400px; padding: 15px;">
          <div class="wi-type-toggle" style="margin-bottom:10px;">
            <div class="wi-type-option ${bugAgentState.wiType === 'Bug' ? 'active' : ''}" id="opt-bug" onclick="selectWIType('Bug')">🐛 Bug</div>
            <div class="wi-type-option ${bugAgentState.wiType === 'Feature' ? 'active' : ''}" id="opt-feature" onclick="selectWIType('Feature')">✨ Feature</div>
            <div class="wi-type-option ${bugAgentState.wiType === 'User Story' ? 'active' : ''}" id="opt-story" onclick="selectWIType('User Story')">📖 User Story</div>
          </div>

          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
            <label style="font-weight:700; color:#1e293b; font-size:0.75rem; text-transform:uppercase; letter-spacing:0.5px;">TFS Details</label>
            <div style="display:flex; align-items:center; gap:8px;">
                <input type="checkbox" id="chk-update-existing" onchange="toggleUpdateMode(this.checked)" />
                <label for="chk-update-existing" style="font-size:0.7rem; font-weight:600; cursor:pointer; margin:0; color:#64748b;">Update Existing</label>
            </div>
          </div>

          <div id="update-id-container" style="display:none; margin-bottom:12px; background:#f0f9ff; padding:10px; border-radius:8px; border:1px solid #bae6fd;">
            <label style="font-size:0.7rem; margin-bottom:4px; font-weight:600; color:#0369a1;">Work Item ID</label>
            <div style="display:flex; gap:8px;">
                <input type="number" id="update-work-item-id" class="config-input" style="height:32px; flex:1; font-size:0.75rem;" placeholder="Enter ID..." />
                <button onclick="fetchExistingWI()" class="btn-secondary" style="height:32px; padding:0 10px; font-size:0.7rem; background:white;">Fetch</button>
            </div>
            <div id="fetch-status" style="font-size:0.65rem; margin-top:2px;"></div>
          </div>

          <div class="config-row" style="margin-bottom:8px;">
            <label style="font-size:0.7rem; margin-bottom:2px; font-weight:700; color:#334155;">Title <span style="color:red">*</span></label>
            <input type="text" id="wi-title" class="config-input" style="height:32px; border-radius:6px; font-size:0.8rem;" placeholder="Clear title..." />
          </div>

          <div class="config-row" style="margin-bottom:8px; position:relative;">
            <label id="lbl-description" style="font-size:0.7rem; font-weight:700; color:#334155; margin-bottom:2px; display:block;">Description / Steps <span style="color:red">*</span></label>
            <div style="position:relative;">
              <textarea id="wi-description" class="config-input" style="height:100px; border-radius:6px; font-family:monospace; font-size:0.75rem; line-height:1.4; padding-right:30px;" placeholder="Details..."></textarea>
              <button onclick="openLargeEditor('wi-description', 'Work Item Editor')" style="position:absolute; right:8px; top:6px; background:none; border:none; font-size:16px; cursor:pointer; color:var(--accent); opacity:0.6; transition:opacity 0.2s; padding:0; display:flex; align-items:center; justify-content:center;" onmouseover="this.style.opacity='1'" onmouseout="this.style.opacity='0.6'" title="Fullscreen Editor">⤢</button>
            </div>
          </div>

          <div style="display:grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-bottom: 15px; width: 100%;">
            <div class="config-row" style="width: 100%;">
              <label style="font-size:0.75rem; margin-bottom:6px; font-weight:700; color:#334155; display:flex; align-items:center; gap:5px;">
                Area Path
              </label>
              <div class="custom-dropdown-container" style="width: 100%;">
                <input type="text" id="wi-area" class="config-input" style="width: 100%; height:40px; font-size:0.85rem; border-radius:8px; padding: 0 14px;" placeholder="Search area..." onfocus="showDropdown('area')" oninput="filterDropdown('area', this.value)" />
                <div id="dropdown-area" class="custom-dropdown-list" style="width: 100%;"></div>
              </div>
            </div>
            <div class="config-row" style="width: 100%;">
              <label style="font-size:0.75rem; margin-bottom:6px; font-weight:700; color:#334155; display:flex; align-items:center; gap:5px;">
                Iteration Path
              </label>
              <div class="custom-dropdown-container" style="width: 100%;">
                <input type="text" id="wi-iteration" class="config-input" style="width: 100%; height:40px; font-size:0.85rem; border-radius:8px; padding: 0 14px;" placeholder="Search iteration..." onfocus="showDropdown('iteration')" oninput="filterDropdown('iteration', this.value)" />
                <div id="dropdown-iteration" class="custom-dropdown-list" style="width: 100%;"></div>
              </div>
            </div>
          </div>

          <div id="row-bug-triage" style="display:grid; grid-template-columns: 1fr 1fr 1fr; gap: 15px; margin-bottom: 15px; width: 100%;">
            <div class="config-row" style="width: 100%;">
              <label style="font-size:0.75rem; margin-bottom:6px; font-weight:700; color:#334155; display:flex; align-items:center; gap:5px;">
                Severity
              </label>
              <select id="wi-severity" class="config-input" style="width: 100%; height:40px; font-size:0.85rem; border-radius:8px; padding: 0 10px;">
                <option value="1 - Critical">Critical</option>
                <option value="2 - High" selected>High</option>
                <option value="3 - Medium">Medium</option>
                <option value="4 - Low">Low</option>
              </select>
            </div>
            <div class="config-row" style="width: 100%;">
              <label style="font-size:0.75rem; margin-bottom:6px; font-weight:700; color:#334155;">Priority</label>
              <select id="wi-priority" class="config-input" style="width: 100%; height:40px; font-size:0.85rem; border-radius:8px; padding: 0 10px;">
                <option value="1">1</option>
                <option value="2" selected>2</option>
                <option value="3">3</option>
              </select>
            </div>
            <div class="config-row" id="col-tags-bug" style="width: 100%;">
              <label style="font-size:0.75rem; margin-bottom:6px; font-weight:700; color:#334155; display:flex; align-items:center; gap:5px;">
                Tags
              </label>
              <input type="text" id="wi-tags" class="config-input" style="width: 100%; height:40px; font-size:0.85rem; border-radius:8px; padding: 0 14px;" placeholder="Tags" />
            </div>
          </div>

          <div id="row-story-assigned" style="display:grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-bottom: 15px; width: 100%;">
            <div class="config-row" style="width: 100%;">
              <label style="font-size:0.75rem; margin-bottom:6px; font-weight:700; color:#334155; display:flex; align-items:center; gap:5px;">
                Story Link ID
              </label>
              <div class="custom-dropdown-container" style="width: 100%;">
                <input type="text" id="wi-story-link" class="config-input" style="width: 100%; height:40px; font-size:0.85rem; border-radius:8px; padding: 0 14px;" placeholder="Link to story..." onfocus="showDropdown('stories')" oninput="filterDropdown('stories', this.value)" />
                <div id="dropdown-stories" class="custom-dropdown-list" style="width: 100%;"></div>
              </div>
            </div>
            <div class="config-row" style="width: 100%;">
              <label style="font-size:0.75rem; margin-bottom:6px; font-weight:700; color:#334155; display:flex; align-items:center; gap:5px;">
                Assigned To
              </label>
              <div class="custom-dropdown-container" style="width: 100%;">
                <input type="text" id="wi-assigned" class="config-input" style="width: 100%; height:40px; font-size:0.85rem; border-radius:8px; padding: 0 14px;" placeholder="Search members..." onfocus="showDropdown('members')" oninput="filterDropdown('members', this.value)" />
                <div id="dropdown-members" class="custom-dropdown-list" style="width: 100%;"></div>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;






    // Initialize state and fetch defaults
    initBugAgentState();

  } else if (agentId === 'dashboard') {
    configTitle.textContent = 'Step 2: Dashboard Configuration';
    configDesc.textContent = 'Configure TFS queries and upload Excel reports';

    configForm.innerHTML = `
      <!-- Section 1: TFS Queries -->
      <div style="margin-bottom:24px;">
        <div style="font-size:1rem;font-weight:700;color:#b45309;margin-bottom:14px;display:flex;align-items:center;gap:8px;">
          <span>1.</span> TFS QA Activity Queries
        </div>
        
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;">
          <div class="config-row" style="margin-bottom:0;">
            <label style="font-size:var(--fs-sm);font-weight:var(--fw-semibold);color:var(--ink);">Bug Query</label>
            <input class="config-input" id="dash-bug-query" type="text" placeholder="Paste ID/URL or select from list..."
              style="height:36px;padding:4px 8px;font-size:0.9rem;width:100%;"
              onfocus="dashShowQueryDropdown('bug',this)" onmousedown="dashShowQueryDropdown('bug',this)"
              onblur="setTimeout(()=>dashHideQueryDropdown('bug'),200)"
              oninput="dashFilterQueryDropdown('bug',this.value,this)" autocomplete="off" />
          </div>
          <div class="config-row" style="margin-bottom:0;">
            <label style="font-size:var(--fs-sm);font-weight:var(--fw-semibold);color:var(--ink);">Retesting Query</label>
            <input class="config-input" id="dash-retest-query" type="text" placeholder="Paste ID/URL or select from list..."
              style="height:36px;padding:4px 8px;font-size:0.9rem;width:100%;"
              onfocus="dashShowQueryDropdown('retest',this)" onmousedown="dashShowQueryDropdown('retest',this)"
              onblur="setTimeout(()=>dashHideQueryDropdown('retest'),200)"
              oninput="dashFilterQueryDropdown('retest',this.value,this)" autocomplete="off" />
          </div>
          <div class="config-row" style="margin-bottom:0;">
            <label style="font-size:var(--fs-sm);font-weight:var(--fw-semibold);color:var(--ink);">User Story Query</label>
            <input class="config-input" id="dash-story-query" type="text" placeholder="Paste ID/URL or select from list..."
              style="height:36px;padding:4px 8px;font-size:0.9rem;width:100%;"
              onfocus="dashShowQueryDropdown('story',this)" onmousedown="dashShowQueryDropdown('story',this)"
              onblur="setTimeout(()=>dashHideQueryDropdown('story'),200)"
              oninput="dashFilterQueryDropdown('story',this.value,this)" autocomplete="off" />
          </div>
          <div class="config-row" style="margin-bottom:0;">
            <label style="font-size:var(--fs-sm);font-weight:var(--fw-semibold);color:var(--ink);">Other Query</label>
            <input class="config-input" id="dash-other-query" type="text" placeholder="Paste ID/URL or select from list..."
              style="height:36px;padding:4px 8px;font-size:0.9rem;width:100%;"
              onfocus="dashShowQueryDropdown('other',this)" onmousedown="dashShowQueryDropdown('other',this)"
              onblur="setTimeout(()=>dashHideQueryDropdown('other'),200)"
              oninput="dashFilterQueryDropdown('other',this.value,this)" autocomplete="off" />
          </div>
        </div>
        <div id="dash-query-load-status" style="margin-top:8px;font-size:0.82rem;color:#64748b;"></div>
      </div>

      <div style="height:1px;background:#e2e8f0;margin-bottom:20px;"></div>

      <!-- Section 2/3/4: Excel Uploads -->
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-bottom:24px;">
        <div style="border:2px dashed #93c5fd;border-radius:8px;padding:14px;background:#eff6ff;text-align:center;">
          <div style="font-weight:700;color:#1d4ed8;margin-bottom:8px;font-size:0.9rem;">2. Vertical Validation</div>
          <label style="cursor:pointer;display:block;padding:8px;background:#dbeafe;border-radius:6px;font-size:0.85rem;color:#1e40af;font-weight:600;min-height:36px;display:flex;align-items:center;justify-content:center;word-break:break-all;">
            <span id="dash-vertical-name">📎 Click to upload .xlsx</span>
            <input type="file" id="dash-vertical-excel" accept=".xlsx,.xls" style="display:none;" />
          </label>
        </div>
        <div style="border:2px dashed #86efac;border-radius:8px;padding:14px;background:#f0fdf4;text-align:center;">
          <div style="font-weight:700;color:#15803d;margin-bottom:8px;font-size:0.9rem;">3. Automation</div>
          <label style="cursor:pointer;display:block;padding:8px;background:#dcfce7;border-radius:6px;font-size:0.85rem;color:#166534;font-weight:600;min-height:36px;display:flex;align-items:center;justify-content:center;word-break:break-all;">
            <span id="dash-automation-name">📎 Click to upload .xlsx</span>
            <input type="file" id="dash-automation-excel" accept=".xlsx,.xls" style="display:none;" />
          </label>
        </div>
        <div style="border:2px dashed #fca5a5;border-radius:8px;padding:14px;background:#fff5f5;text-align:center;">
          <div style="font-weight:700;color:#dc2626;margin-bottom:8px;font-size:0.9rem;">4. Performance</div>
          <label style="cursor:pointer;display:block;padding:8px;background:#fee2e2;border-radius:6px;font-size:0.85rem;color:#991b1b;font-weight:600;min-height:36px;display:flex;align-items:center;justify-content:center;word-break:break-all;">
            <span id="dash-performance-name">📎 Click to upload .xlsx</span>
            <input type="file" id="dash-performance-excel" accept=".xlsx,.xls" style="display:none;" />
          </label>
        </div>
      </div>
      <div style="height:1px;background:#e2e8f0;margin-bottom:20px;"></div>

      <!-- Section 5: Dashboard Mode -->
      <div style="margin-bottom:20px;">
        <label style="font-size:var(--fs-sm);font-weight:var(--fw-semibold);color:var(--ink);display:block;margin-bottom:10px;">5. Dashboard Mode</label>
        <div style="display:flex;gap:16px;">
          <label style="display:flex;align-items:center;gap:8px;cursor:pointer;padding:10px 16px;border:2px solid #0066cc;border-radius:8px;background:#f0f9ff;font-weight:600;font-size:0.9rem;">
            <input type="radio" name="dash-mode" value="static" checked onchange="dashModeChanged(this.value)" style="width:16px;height:16px;" />
            📊 Static Dashboard
          </label>
          <label style="display:flex;align-items:center;gap:8px;cursor:pointer;padding:10px 16px;border:2px solid #ddd;border-radius:8px;background:white;font-weight:600;font-size:0.9rem;">
            <input type="radio" name="dash-mode" value="ai" onchange="dashModeChanged(this.value)" style="width:16px;height:16px;" />
            🤖 AI-Generated Dashboard
          </label>
        </div>
      </div>

      <!-- Section 6: LLM Prompt (shown only for AI mode) -->
      <div id="dash-prompt-section" style="display:none;margin-bottom:16px;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
          <label style="font-size:var(--fs-sm);font-weight:var(--fw-semibold);color:var(--ink);">6. Strategic Analysis Prompt (LLM)</label>
          <button onclick="dashUseDefaultPrompt()" style="padding:6px 12px;background:#e0f2fe;color:#0f172a;border:1px solid #bae6fd;border-radius:6px;cursor:pointer;font-size:12px;font-weight:600;">Use Default Prompt</button>
        </div>
        <div style="position:relative;">
          <textarea class="config-input" id="dash-llm-prompt" style="min-height:140px;font-size:0.85rem;font-family:monospace;padding-right:35px;" placeholder="Enter your strategic analysis prompt...">${DASHBOARD_DEFAULT_PROMPT}</textarea>
          <button onclick="openLargeEditor('dash-llm-prompt', 'Strategic Analysis Prompt Editor')" title="Fullscreen Editor" style="position:absolute;right:10px;top:10px;background:none;border:none;font-size:18px;cursor:pointer;color:var(--accent);opacity:0.6;transition:opacity 0.2s;z-index:2;padding:0;display:flex;align-items:center;justify-content:center;" onmouseover="this.style.opacity='1'" onmouseout="this.style.opacity='0.6'">⤢</button>
        </div>
      </div>
    `;

    // Show file name when chosen
    ['dash-vertical-excel','dash-automation-excel','dash-performance-excel'].forEach(id => {
      const input = document.getElementById(id);
      const nameEl = document.getElementById(id.replace('-excel','-name'));
      if (input && nameEl) {
        input.addEventListener('change', () => {
          if (input.files[0]) {
            nameEl.textContent = `✅ ${input.files[0].name}`;
          } else {
            nameEl.textContent = '📎 Click to upload .xlsx';
          }
        });
      }
    });

    // Use already-loaded queries if available, otherwise trigger a load
    if (_dashQueries.length > 0) {
      const statusEl = document.getElementById('dash-query-load-status');
      if (statusEl) {
          statusEl.innerHTML = `✅ ${_dashQueries.length} queries loaded — click a field to select or type to filter <span onclick="dashLoadQueries()" title="Refresh" style="cursor:pointer;margin-left:8px;font-weight:bold;color:#b45309;font-size:1.1rem;">↻</span>`;
      }
    } else {
      dashLoadQueries();
    }
  }
  
  // [AGENT 2] Initialize test case UI elements if needed
  if (agentId === 'test-case' && typeof initializeTestCaseConfigStep2 === 'function') {
    initializeTestCaseConfigStep2();
  }
  
  console.log('Config form populated for:', agentId);
}
function switchInputMethod(method) {
  // Update button styles
  document.querySelectorAll('.input-method-btn').forEach(btn => {
    btn.style.borderColor = '#ddd';
    btn.style.background = 'white';
  });
  
  const activeBtn = document.getElementById(`method-${method}`);
  if (activeBtn) {
    activeBtn.style.borderColor = '#0066cc';
    activeBtn.style.background = '#f0f9ff';
  }
  
  // Show/hide sections
  document.querySelectorAll('.input-section').forEach(section => {
    section.style.display = 'none';
  });
  
  const activeSection = document.getElementById(`section-${method}`);
  if (activeSection) {
    activeSection.style.display = 'block';
  }
  
  console.log('Input method switched to:', method);
}

// ==================== Dashboard Agent Helpers (Agent #4) ====================

const DASHBOARD_DEFAULT_PROMPT = `### ROLE:
Act as a Senior Strategic QA Director (20+ years experience). Provide a high-impact, executive-level strategic analysis of the project's quality health.

### DATASETS FOR ANALYSIS:
- TFS ACTIVITY SUMMARY: {tfs_summary}
- VERTICAL VALIDATION REPORT: {vertical_report}
- AUTOMATION COVERAGE REPORT: {automation_report}
- PERFORMANCE REPORT: {performance_report}

### OUTPUT STRUCTURE & STYLE:
Your response MUST be professional and highly readable.
- USE **BOLD CAPITALIZED HEADINGS** for main sections.
- USE *Italicized Title Case* for sub-headings.
- USE standard bullets (• or -) or numbers (1, 2, 3) for points.
- DO NOT use "## **" or "### **" combinations.

1. **EXECUTIVE SUMMARY**
   Provide a 2-sentence high-level summary. Start with a clear "Quality Status" (e.g., EXCELLENT, STABLE, AT RISK, CRITICAL).

2. **KEY QUALITY INDICATORS (KQIs)**
   *Correlation Analysis*
   Briefly interpret the correlation between TFS activity, vertical validation, and automation.

3. **TOP STRATEGIC RISKS**
   *Risk 1: [Title]*
   Root Cause analysis and Potential Impact based on the data.
   *Risk 2: [Title]*
   Root Cause analysis and Potential Impact.

4. **ACTIONABLE ROADMAP**
   *Prioritized Actions*
   Provide 3 high-priority recommendations with clear owners.

5. **CONFIDENCE SCORE**
   Rate from 0 to 100. Provide a one-sentence justification.

Keep the tone professional, authoritative, and focused on delivery excellence.`;

function dashModeChanged(value) {
  const promptSection = document.getElementById('dash-prompt-section');
  if (promptSection) {
    promptSection.style.display = value === 'ai' ? 'block' : 'none';
  }
  // update radio label styles
  document.querySelectorAll('[name="dash-mode"]').forEach(radio => {
    const label = radio.closest('label');
    if (!label) return;
    if (radio.value === value) {
      label.style.borderColor = '#0066cc';
      label.style.background = '#f0f9ff';
    } else {
      label.style.borderColor = '#ddd';
      label.style.background = 'white';
    }
  });
}

function dashUseDefaultPrompt() {
  const el = document.getElementById('dash-llm-prompt');
  if (el) el.value = DASHBOARD_DEFAULT_PROMPT;
}

// Store loaded queries for filtering
let _dashQueries = [];

async function dashLoadQueries() {
  const statusEl = document.getElementById('dash-query-load-status');
  if (statusEl) statusEl.textContent = '⏳ Loading TFS saved queries...';

  const tfs = getEffectiveTFSConfig();
  if (!tfs || (!tfs.base_url && !tfs.task_url)) {
    if (statusEl) statusEl.textContent = '⚠️ TFS not configured — enter a Task URL in TFS config or paste query IDs manually.';
    return;
  }
  const hasPAT = !!(tfs.pat_token && tfs.pat_token.trim());
  const hasUserPass = !!(tfs.username && tfs.username.trim() && tfs.password && tfs.password.trim());
  if (!hasPAT && !hasUserPass) {
    if (statusEl) statusEl.textContent = '⚠️ Authentication missing — add PAT or Username/Password in TFS config to load queries automatically.';
    return;
  }

  try {
    const resp = await fetchWithTimeout(`${API_BASE}/dashboard/queries`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tfs_config: {
            base_url: tfs.base_url || '',
            task_url: tfs.task_url || '',
            pat_token: tfs.pat_token || '',
            username: tfs.username || '',
            password: tfs.password || ''
          }
        })
      }, 60000);

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.detail || `HTTP ${resp.status}`);
    }

    const data = await resp.json();
    _dashQueries = data.queries || [];

    if (statusEl) {
      statusEl.innerHTML = _dashQueries.length > 0
        ? `✅ ${_dashQueries.length} queries loaded — click a field to select or type to filter <span onclick="dashLoadQueries()" title="Refresh" style="cursor:pointer;margin-left:8px;font-weight:bold;color:#b45309;font-size:1.1rem;">↻</span>`
        : `⚠️ No saved queries found in TFS project <span onclick="dashLoadQueries()" title="Refresh" style="cursor:pointer;margin-left:8px;font-weight:bold;color:#b45309;font-size:1.1rem;">↻</span>`;
    }

    addDebugLog(`Dashboard: ${_dashQueries.length} queries loaded`);
  } catch (err) {
    if (statusEl) statusEl.textContent = `⚠️ Could not load queries: ${err.message}. Enter query IDs manually.`;
    addDebugLog(`Dashboard query load failed: ${err.message}`);
  }
}

function dashRenderList(key, queries) {
  const listEl = document.getElementById(`dash-${key}-query-list`);
  if (!listEl) return;
  if (!queries || !queries.length) {
    listEl.innerHTML = '<div style="padding:8px 10px;color:#999;font-size:0.85rem;">No queries available</div>';
    return;
  }
  listEl.innerHTML = queries.map(q => {
    const label = q.path ? `${q.path} / ${q.name}` : q.name;
    const safeLabel = label.replace(/\\/g,'\\\\').replace(/'/g,"\\'");
    const safeId = (q.id || '').replace(/'/g,"\\'");
    const rawDate = q.lastModifiedDate || q.createdDate || '';
    const dateStr = rawDate ? new Date(rawDate).toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'numeric'}) : '';
    return `<div style="padding:7px 10px;border-bottom:1px solid #f0f0f0;cursor:pointer;font-size:0.85rem;background:transparent;transition:background 0.15s;"
      onmouseover="this.style.background='#f0f9ff'"
      onmouseout="this.style.background='transparent'"
      onmousedown="event.preventDefault();dashSelectQuery('${key}','${safeId}','${safeLabel}');return false;">
      <div style="font-weight:600;color:#0f172a;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${q.name}</div>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-top:2px;">
        ${q.path ? `<span style="color:#64748b;font-size:0.76rem;">${q.path}</span>` : '<span></span>'}
        ${dateStr ? `<span style="color:#94a3b8;font-size:0.74rem;flex-shrink:0;margin-left:8px;">📅 ${dateStr}</span>` : ''}
      </div>
    </div>`;
  }).join('');
}

function dashSelectQuery(key, queryId, label) {
  const input = document.getElementById(`dash-${key}-query`);
  if (input) {
    input.value = label;
    input.dataset.queryId = queryId;
  }
  dashHideQueryDropdown(key);
}

function _dashGetOrCreatePortal(key) {
  let portal = document.getElementById(`dash-${key}-query-dropdown`);
  if (!portal) {
    portal = document.createElement('div');
    portal.id = `dash-${key}-query-dropdown`;
    portal.style.cssText = 'display:none;position:fixed;background:white;border:1px solid #cbd5e1;border-radius:0 0 6px 6px;max-height:220px;overflow-y:auto;z-index:99999;box-shadow:0 6px 16px rgba(0,0,0,0.12);';
    const list = document.createElement('div');
    list.id = `dash-${key}-query-list`;
    portal.appendChild(list);
    document.body.appendChild(portal);
  }
  return portal;
}

function dashShowQueryDropdown(key, inputEl) {
  const portal = _dashGetOrCreatePortal(key);
  const rect = inputEl.getBoundingClientRect();
  portal.style.left = rect.left + 'px';
  portal.style.top = rect.bottom + 'px';
  portal.style.width = rect.width + 'px';
  portal.style.display = 'block';
  dashRenderList(key, _dashQueries);
}

function dashHideQueryDropdown(key) {
  const portal = document.getElementById(`dash-${key}-query-dropdown`);
  if (portal) portal.style.display = 'none';
}

function dashFilterQueryDropdown(key, searchText, inputEl) {
  const portal = _dashGetOrCreatePortal(key);
  const rect = inputEl.getBoundingClientRect();
  portal.style.left = rect.left + 'px';
  portal.style.top = rect.bottom + 'px';
  portal.style.width = rect.width + 'px';
  portal.style.display = 'block';

  const search = (searchText || '').toLowerCase().trim();
  const filtered = search
    ? _dashQueries.filter(q => `${q.name} ${q.path || ''}`.toLowerCase().includes(search))
    : _dashQueries;
  dashRenderList(key, filtered);

  if (inputEl) inputEl.dataset.queryId = '';
}

async function _fileToB64(fileInput) {
  const file = fileInput?.files?.[0];
  if (!file) return null;
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = e => resolve(e.target.result.split(',')[1]); // strip data:...;base64,
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function renderDashboardResult(result) {
  const outputEl = document.getElementById('dashboard-content');
  if (!outputEl) return;

  const s     = result.summary            || {};
  const rows  = result.state_rows         || [];
  const cards = result.management_cards   || [];
  const trend = result.trend              || {};
  const bugC  = result.bug_charts         || {};
  const vr    = result.vertical_report;
  const ar    = result.automation_report;
  const pr    = result.performance_report;
  const uid   = Date.now(); // canvas id collision guard

  // ── tone → CSS gradient ──────────────────────────────────────────
  const toneBg = {
    primary: 'linear-gradient(180deg,#eef4ff,#dbeafe)',
    success: 'linear-gradient(180deg,#ecfdf5,#d1fae5)',
    accent:  'linear-gradient(180deg,#fff7ed,#ffedd5)',
    danger:  'linear-gradient(180deg,#fff1f2,#ffe4e6)',
    warning: 'linear-gradient(180deg,#fefce8,#fef08a)',
  };
  const toneColor = {primary:'#1d4ed8',success:'#0f766e',accent:'#b45309',danger:'#b42318',warning:'#a16207'};

  const cardHtml = (label, value, tone) => `
    <div style="border-radius:16px;padding:16px 14px;min-height:100px;display:flex;flex-direction:column;justify-content:space-between;background:${toneBg[tone]||toneBg.primary};">
      <div style="font-size:2rem;font-weight:800;color:${toneColor[tone]||'#1d4ed8'};">${value}</div>
      <div style="color:#44536b;font-weight:600;font-size:0.85rem;">${label}</div>
    </div>`;

  // ── helper: state table row ──────────────────────────────────────
  const stateRow = r => `<tr>
    <td style="padding:9px 12px;border-bottom:1px solid #e2e8f0;font-weight:600;">${r.category}</td>
    <td style="padding:9px 12px;border-bottom:1px solid #e2e8f0;text-align:center;">${r.total}</td>
    <td style="padding:9px 12px;border-bottom:1px solid #e2e8f0;text-align:center;">${r.closed}</td>
    <td style="padding:9px 12px;border-bottom:1px solid #e2e8f0;text-align:center;color:#d97706;">${r.active}</td>
    <td style="padding:9px 12px;border-bottom:1px solid #e2e8f0;text-align:center;color:#64748b;">${r.other}</td>
  </tr>`;

  const sectionStyle = 'margin-bottom:20px;background:#fff;border-radius:18px;padding:20px;box-shadow:0 4px 16px rgba(15,23,42,0.07);';
  const panelStyle   = 'border:1px solid #dde4ef;border-radius:14px;padding:16px;background:#fbfdff;';
  const tableWrap    = 'overflow:auto;border:1px solid #e2e8f0;border-radius:12px;margin-top:14px;';
  const thStyle      = 'padding:9px 12px;background:#f8fafc;color:#30425d;font-size:12px;text-transform:uppercase;letter-spacing:.03em;text-align:left;border-bottom:1px solid #e2e8f0;cursor:pointer;user-select:none;white-space:nowrap;';
  const tag = (txt, ok) => `<span style="display:inline-block;padding:3px 9px;border-radius:999px;font-size:12px;font-weight:700;background:${ok?'#ccfbf1':'#fee4e2'};color:${ok?'#0f766e':'#b42318'};">${txt}</span>`;

  // ── inject interactive CSS once ─────────────────────────────────
  if (!document.getElementById('dash-interactive-css')) {
    const s = document.createElement('style');
    s.id = 'dash-interactive-css';
    s.textContent = `
      #dashboard-content tr:hover td { background:#f8fafc; }
      #dashboard-content th.sort-asc::after  { content:' ▲'; font-size:10px; opacity:.7; }
      #dashboard-content th.sort-desc::after { content:' ▼'; font-size:10px; opacity:.7; }
      #dashboard-content th:hover { background:#eef2f7 !important; }
      .dash-progress { height:6px; border-radius:4px; background:#e2e8f0; overflow:hidden; margin-top:3px; }
      .dash-progress-fill { height:100%; border-radius:4px; transition:width .4s ease; }
      .dash-copy-btn { border:1px solid #d8e0eb; border-radius:8px; padding:5px 8px; background:#f8fafc;
        color:#475467; font-size:15px; cursor:pointer; line-height:1; position:relative; }
      .dash-copy-btn:hover { background:#eef4ff; color:#1d4ed8; border-color:#bfdbfe; }
      .dash-copy-btn .dash-tip { display:none; position:absolute; right:0; top:calc(100% + 6px); background:#1e293b;
        color:#fff; font-size:11px; font-weight:600; white-space:nowrap; padding:4px 8px; border-radius:6px; z-index:99; }
      .dash-copy-btn:hover .dash-tip { display:block; }
      .dash-search { width:100%; padding:8px 12px; border:1px solid #d8e0eb; border-radius:10px;
        font-size:0.85rem; color:#1e293b; outline:none; box-sizing:border-box; }
      .dash-search:focus { border-color:#2563eb; box-shadow:0 0 0 3px rgba(37,99,235,.1); }
      .dash-nav-chip { display:inline-block; padding:6px 14px; border-radius:999px; background:rgba(255,255,255,.14);
        color:rgba(255,255,255,.9); font-size:0.8rem; font-weight:600; text-decoration:none; margin-right:6px; }
      .dash-nav-chip:hover { background:rgba(255,255,255,.25); color:white; }
      .dash-chart-btn { border:1px solid #d8e0eb; border-radius:7px; padding:4px 7px; background:#f8fafc;
        color:#475467; font-size:13px; cursor:pointer; line-height:1; }
      .dash-chart-btn:hover { background:#eef4ff; color:#1d4ed8; border-color:#bfdbfe; }
      #dashboard-content details summary { list-style:none; }
      #dashboard-content details summary::-webkit-details-marker { display:none; }
      #dashboard-content details summary::marker { display:none; }
    `;
    document.head.appendChild(s);
  }

  // ── sortable table helper ────────────────────────────────────────
  const makeSortable = (tableId) => {
    const tbl = document.getElementById(tableId);
    if (!tbl) return;
    tbl.querySelectorAll('th').forEach((th, ci) => {
      th.addEventListener('click', () => {
        const tbody = tbl.querySelector('tbody');
        if (!tbody) return;
        const asc = !th.classList.contains('sort-asc');
        tbl.querySelectorAll('th').forEach(h => h.classList.remove('sort-asc','sort-desc'));
        th.classList.add(asc ? 'sort-asc' : 'sort-desc');
        const rows = Array.from(tbody.querySelectorAll('tr'));
        rows.sort((a, b) => {
          const av = (a.cells[ci]?.textContent||'').trim();
          const bv = (b.cells[ci]?.textContent||'').trim();
          const an = parseFloat(av), bn = parseFloat(bv);
          if (!isNaN(an) && !isNaN(bn)) return asc ? an-bn : bn-an;
          return asc ? av.localeCompare(bv) : bv.localeCompare(av);
        });
        rows.forEach(r => tbody.appendChild(r));
      });
    });
  };

  // ── progress bar helper ──────────────────────────────────────────
  const progressBar = (pct, color) => `
    <div class="dash-progress"><div class="dash-progress-fill" style="width:${Math.min(100,pct||0)}%;background:${color};"></div></div>`;

  // ── chart copy/download buttons ──────────────────────────────────
  const chartActions = (cid) => `<div style="display:flex;gap:3px;flex-shrink:0;margin-left:8px;">
    <button class="dash-chart-btn" onclick="window._dashCopyChart('${cid}')" title="Copy chart as image"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle;"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg></button>
    <button class="dash-chart-btn" onclick="window._dashDownloadChart('${cid}')" title="Download chart as PNG"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle;"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/></svg></button>
  </div>`;

  // ── chart colour palette ─────────────────────────────────────────
  const CPALET = ['#60a5fa','#34d399','#f97316','#a78bfa','#fb7185','#fbbf24','#22d3ee','#4ade80','#f472b6','#818cf8','#2dd4bf','#facc15'];
  const palFor  = (n) => Array.from({length:n}, (_,i) => CPALET[i % CPALET.length]);

  let html = '';

  // ── HERO ────────────────────────────────────────────────────────
  html += `<div id="dash-top-${uid}" style="padding:22px 24px;border-radius:18px;background:linear-gradient(135deg,#14b8a6,#0f766e);color:white;margin-bottom:20px;">
    <div style="font-size:1.5rem;font-weight:800;margin-bottom:6px;">QA Management Dashboard</div>
    <div style="color:rgba(255,255,255,.85);font-size:0.9rem;line-height:1.5;margin-bottom:14px;">TFS activity combined with vertical validation, automation coverage and performance evidence.</div>
    <div>
      <a href="#dash-tfs-${uid}"  class="dash-nav-chip">TFS Activity</a>
      <a href="#dash-vt-${uid}"   class="dash-nav-chip">Vertical</a>
      <a href="#dash-auto-${uid}" class="dash-nav-chip">Automation</a>
      <a href="#dash-perf-${uid}" class="dash-nav-chip">Performance</a>
      <a href="#dash-mgmt-${uid}" class="dash-nav-chip">Summary</a>
    </div>
  </div>`;

  // ── EXECUTIVE OVERVIEW ──────────────────────────────────────────
  html += `<div style="${sectionStyle}">
    <div style="font-size:1.25rem;font-weight:700;color:#14213d;margin-bottom:4px;">Executive Overview</div>
    <div style="color:#667085;font-size:0.85rem;margin-bottom:14px;">Quick picture of QA execution from TFS + uploaded Excel evidence.</div>
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:12px;">
      ${cards.map(c => cardHtml(c.label, c.value, c.tone)).join('')}
    </div>
    ${(()=>{
      const src = result.sources || {};
      const chips = [];
      if (src.bugs?.source_url)      chips.push(`<a href="${src.bugs.source_url}" target="_blank" rel="noopener" style="display:inline-flex;align-items:center;padding:10px 14px;border-radius:999px;background:#eef4ff;color:#1d4ed8;text-decoration:none;font-weight:700;font-size:0.85rem;">Bugs Created By QA ↗</a>`);
      if (src.retesting?.source_url) chips.push(`<a href="${src.retesting.source_url}" target="_blank" rel="noopener" style="display:inline-flex;align-items:center;padding:10px 14px;border-radius:999px;background:#eef4ff;color:#1d4ed8;text-decoration:none;font-weight:700;font-size:0.85rem;">Bugs Retested ↗</a>`);
      if (src.stories?.source_url)   chips.push(`<a href="${src.stories.source_url}" target="_blank" rel="noopener" style="display:inline-flex;align-items:center;padding:10px 14px;border-radius:999px;background:#eef4ff;color:#1d4ed8;text-decoration:none;font-weight:700;font-size:0.85rem;">User Stories In QA ↗</a>`);
      if (src.other?.source_url)     chips.push(`<a href="${src.other.source_url}" target="_blank" rel="noopener" style="display:inline-flex;align-items:center;padding:10px 14px;border-radius:999px;background:#eef4ff;color:#1d4ed8;text-decoration:none;font-weight:700;font-size:0.85rem;">Other TFS Link ↗</a>`);
      return chips.length ? `<div style="display:flex;flex-wrap:wrap;gap:10px;margin-top:14px;">${chips.join('')}</div>` : '';
    })()}
  </div>`;

  // ── TFS QA ACTIVITY ─────────────────────────────────────────────
  html += `<div id="dash-tfs-${uid}" style="${sectionStyle}">
    <div style="font-size:1.25rem;font-weight:700;color:#14213d;margin-bottom:4px;">TFS QA Activity</div>`;

  if (result.has_tfs_data) {
    html += `<div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:14px;">
      <div style="${panelStyle}">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;">
          <div>
            <div style="font-weight:700;color:#1e293b;margin-bottom:2px;">QA Work Distribution</div>
            <div style="color:#667085;font-size:0.8rem;margin-bottom:10px;">Full query totals across all categories.</div>
          </div>
          ${chartActions(`dash_trend_${uid}`)}
        </div>
        <div style="height:220px;position:relative;"><canvas id="dash_trend_${uid}"></canvas></div>
      </div>
      <div style="${panelStyle}">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;">
          <div>
            <div style="font-weight:700;color:#1e293b;margin-bottom:2px;">Bugs Created By QA — Ownership</div>
            <div style="color:#667085;font-size:0.8rem;margin-bottom:10px;">Top assignees from the bugs query.</div>
          </div>
          ${chartActions(`dash_bugAssignee_${uid}`)}
        </div>
        <div style="height:220px;position:relative;"><canvas id="dash_bugAssignee_${uid}"></canvas></div>
      </div>
    </div>`;

    // Priority chart row (only if priority data exists)
    if ((bugC.priority||{}).labels?.length) {
      html += `<div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:14px;">
        <div style="${panelStyle}">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;">
            <div>
              <div style="font-weight:700;color:#1e293b;margin-bottom:2px;">Bugs By Priority</div>
              <div style="color:#667085;font-size:0.8rem;margin-bottom:10px;">Distribution of open bugs by priority level.</div>
            </div>
            ${chartActions(`dash_bugPriority_${uid}`)}
          </div>
          <div style="height:200px;position:relative;"><canvas id="dash_bugPriority_${uid}"></canvas></div>
        </div>
        <div style="${panelStyle}">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;">
            <div>
              <div style="font-weight:700;color:#1e293b;margin-bottom:2px;">Bugs By State</div>
              <div style="color:#667085;font-size:0.8rem;margin-bottom:10px;">State breakdown across all bugs created by QA.</div>
            </div>
            ${chartActions(`dash_bugState_${uid}`)}
          </div>
          <div style="height:200px;position:relative;"><canvas id="dash_bugState_${uid}"></canvas></div>
        </div>
      </div>`;
    }

    html += `<div style="${tableWrap}">
      <table id="tbl_state_${uid}" style="width:100%;border-collapse:collapse;font-size:0.88rem;">
        <thead><tr>
          <th style="${thStyle}" title="Click to sort">Category</th>
          <th style="${thStyle}text-align:center;" title="Click to sort">Total</th>
          <th style="${thStyle}text-align:center;" title="Click to sort">Closed</th>
          <th style="${thStyle}text-align:center;" title="Click to sort">Active</th>
          <th style="${thStyle}text-align:center;" title="Click to sort">Other</th>
          <th style="${thStyle}text-align:center;">Closed %</th>
        </tr></thead>
        <tbody>${rows.map(r => {
          const closedPct = r.total > 0 ? Math.round((r.closed/r.total)*100) : 0;
          return `<tr>
            <td style="padding:9px 12px;border-bottom:1px solid #e2e8f0;font-weight:600;">${r.category}</td>
            <td style="padding:9px 12px;border-bottom:1px solid #e2e8f0;text-align:center;">${r.total}</td>
            <td style="padding:9px 12px;border-bottom:1px solid #e2e8f0;text-align:center;">${r.closed}</td>
            <td style="padding:9px 12px;border-bottom:1px solid #e2e8f0;text-align:center;color:#d97706;">${r.active}</td>
            <td style="padding:9px 12px;border-bottom:1px solid #e2e8f0;text-align:center;color:#64748b;">${r.other}</td>
            <td style="padding:9px 12px;border-bottom:1px solid #e2e8f0;min-width:80px;">
              <div style="display:flex;align-items:center;gap:6px;">
                <span style="font-size:11px;font-weight:700;color:#0f766e;min-width:32px;">${closedPct}%</span>
                ${progressBar(closedPct,'#0f766e')}
              </div>
            </td>
          </tr>`;
        }).join('')}</tbody>
      </table>
    </div>`;

    // Bugs detailed table
    const bugTable = bugC.table || [];
    if (bugTable.length) {
      html += `<details style="margin-top:14px;">
        <summary style="cursor:pointer;font-weight:600;color:#1d4ed8;font-size:0.9rem;">▶&nbsp;Bugs Created By QA — Work Item Detail (${bugTable.length})</summary>
        <div style="margin-top:8px;">
          <input class="dash-search" id="bug-search-${uid}" placeholder="Search by title, state, or assignee…" oninput="(function(v){document.querySelectorAll('#bug-tbl-${uid} tbody tr').forEach(r=>{r.style.display=r.textContent.toLowerCase().includes(v.toLowerCase())?'':'none'})})(this.value)" style="margin-bottom:8px;">
        </div>
        <div style="${tableWrap}margin-top:0;">
          <table id="bug-tbl-${uid}" style="width:100%;border-collapse:collapse;font-size:0.82rem;">
            <thead><tr>
              <th style="${thStyle}">ID</th><th style="${thStyle}">Title</th>
              <th style="${thStyle}">State</th><th style="${thStyle}">Assignee</th>
              <th style="${thStyle}">Priority</th><th style="${thStyle}">Changed</th>
            </tr></thead>
            <tbody>${bugTable.map(r => `<tr>
              <td style="padding:7px 10px;border-bottom:1px solid #f0f4f8;">${r.id}</td>
              <td style="padding:7px 10px;border-bottom:1px solid #f0f4f8;max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${r.title}">${r.title}</td>
              <td style="padding:7px 10px;border-bottom:1px solid #f0f4f8;">${r.state}</td>
              <td style="padding:7px 10px;border-bottom:1px solid #f0f4f8;">${r.assignee}</td>
              <td style="padding:7px 10px;border-bottom:1px solid #f0f4f8;">${r.priority}</td>
              <td style="padding:7px 10px;border-bottom:1px solid #f0f4f8;">${r.changed}</td>
            </tr>`).join('')}</tbody>
          </table>
        </div>
      </details>`;
    }
  } else {
    html += `<div style="padding:16px;border:1px dashed #d8e0eb;border-radius:12px;color:#667085;background:#fafcff;margin-top:10px;">No TFS query data was provided. Add one or more TFS query IDs above to include QA execution tracking.</div>`;
  }
  html += `</div>`;

  // ── VERTICAL TESTING ────────────────────────────────────────────
  html += `<div id="dash-vt-${uid}" style="${sectionStyle}">
    <div style="font-size:1.25rem;font-weight:700;color:#14213d;margin-bottom:4px;">Vertical Testing</div>`;
  if (vr) {
    html += `<div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:14px;">
      <div style="${panelStyle}">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;">
          <div>
            <div style="font-weight:700;color:#1e293b;margin-bottom:2px;">Similarity by Vertical</div>
            <div style="color:#667085;font-size:0.8rem;margin-bottom:10px;">Management-ready comparison across uploaded vertical runs.</div>
          </div>
          ${chartActions(`dash_vertical_${uid}`)}
        </div>
        <div style="height:240px;position:relative;"><canvas id="dash_vertical_${uid}"></canvas></div>
      </div>
      <div style="${panelStyle}">
        <div style="font-weight:700;color:#1e293b;margin-bottom:12px;">Highlights</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
          ${cardHtml('Verticals Covered', vr.summary.total_verticals, 'success')}
          ${cardHtml('Questions Evaluated', vr.summary.total_questions, 'primary')}
          ${cardHtml('Average Similarity', vr.summary.avg_similarity + '%', 'accent')}
          ${cardHtml('Best: ' + vr.summary.top_vertical, vr.summary.top_similarity + '%', 'success')}
        </div>
      </div>
    </div>
    <div style="${tableWrap}">
      <table id="tbl_vt_${uid}" style="width:100%;border-collapse:collapse;font-size:0.88rem;">
        <thead><tr>
          <th style="${thStyle}">Chat</th><th style="${thStyle}">Assistant</th>
          <th style="${thStyle}">Vertical</th><th style="${thStyle}">No. of Questions</th><th style="${thStyle}">Similarity</th>
        </tr></thead>
        <tbody>${(vr.rows||[]).map(r => `<tr>
          <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;">${r.chat_name}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;">${r.assistant_name}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;font-weight:600;">${r.vertical}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;">${r.question_count}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;min-width:100px;">
            <div style="display:flex;align-items:center;gap:6px;">
              <span style="font-weight:700;min-width:42px;">${r.similarity}%</span>
              ${progressBar(r.similarity,'#0f766e')}
            </div>
          </td>
        </tr>`).join('')}</tbody>
      </table>
    </div>`;
  } else {
    html += `<div style="padding:16px;border:1px dashed #d8e0eb;border-radius:12px;color:#667085;background:#fafcff;margin-top:10px;">Upload the Vertical Testing Excel to include similarity and question-volume reporting here.</div>`;
  }
  html += `</div>`;

  // ── AUTOMATION COVERAGE ─────────────────────────────────────────
  html += `<div id="dash-auto-${uid}" style="${sectionStyle}">
    <div style="font-size:1.25rem;font-weight:700;color:#14213d;margin-bottom:4px;">Automation Coverage</div>`;
  if (ar) {
    html += `<div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:14px;">
      <div style="${panelStyle}">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;">
          <div>
            <div style="font-weight:700;color:#1e293b;margin-bottom:2px;">Module Coverage</div>
            <div style="color:#667085;font-size:0.8rem;margin-bottom:10px;">Top modules by automation coverage percentage.</div>
          </div>
          ${chartActions(`dash_auto_${uid}`)}
        </div>
        <div style="height:240px;position:relative;"><canvas id="dash_auto_${uid}"></canvas></div>
      </div>
      <div style="${panelStyle}">
        <div style="font-weight:700;color:#1e293b;margin-bottom:12px;">Automation Summary</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
          ${cardHtml('Modules Covered', ar.summary.module_count, 'primary')}
          ${cardHtml('Automated Cases', ar.summary.automated_total, 'success')}
          ${cardHtml('Total TFS Cases', ar.summary.tfs_total, 'accent')}
          ${cardHtml('Overall Coverage', ar.summary.overall_coverage + '%', 'success')}
        </div>
      </div>
    </div>
    <div style="${tableWrap}">
      <table id="tbl_ar_${uid}" style="width:100%;border-collapse:collapse;font-size:0.88rem;">
        <thead><tr>
          <th style="${thStyle}">Module</th><th style="${thStyle}">Total TFS Cases</th>
          <th style="${thStyle}">Automated</th><th style="${thStyle}">Coverage</th><th style="${thStyle}">Status</th>
        </tr></thead>
        <tbody>${(ar.rows||[]).map(r => `<tr>
          <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;font-weight:600;">${r.module_name}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;">${r.total_tfs}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;">${r.automated}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;min-width:110px;">
            <div style="display:flex;align-items:center;gap:6px;">
              <span style="font-weight:700;min-width:42px;">${r.coverage}%</span>
              ${progressBar(r.coverage,'#b45309')}
            </div>
          </td>
          <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;">${r.status ? tag(r.status, r.status.toLowerCase()==='done') : ''}</td>
        </tr>`).join('')}</tbody>
      </table>
    </div>`;
  } else {
    html += `<div style="padding:16px;border:1px dashed #d8e0eb;border-radius:12px;color:#667085;background:#fafcff;margin-top:10px;">Upload the Automation Excel to show module-wise coverage and completion status.</div>`;
  }
  html += `</div>`;

  // ── PERFORMANCE VALIDATION ──────────────────────────────────────
  html += `<div id="dash-perf-${uid}" style="${sectionStyle}">
    <div style="font-size:1.25rem;font-weight:700;color:#14213d;margin-bottom:4px;">Performance Validation</div>`;
  if (pr) {
    html += `<div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:14px;">
      <div style="${panelStyle}">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;">
          <div>
            <div style="font-weight:700;color:#1e293b;margin-bottom:2px;">Worst Peak Response by Scenario</div>
            <div style="color:#667085;font-size:0.8rem;margin-bottom:10px;">Highest observed peak response time from the uploaded performance sheet.</div>
          </div>
          ${chartActions(`dash_perf_${uid}`)}
        </div>
        <div style="height:240px;position:relative;"><canvas id="dash_perf_${uid}"></canvas></div>
      </div>
      <div style="${panelStyle}">
        <div style="font-weight:700;color:#1e293b;margin-bottom:12px;">Performance Summary</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">
          ${cardHtml('Scenarios', pr.summary.scenario_count, 'primary')}
          ${cardHtml('Load Runs', pr.summary.run_count, 'accent')}
          ${cardHtml('Failures', pr.summary.failure_count, pr.summary.failure_count ? 'danger' : 'success')}
          ${cardHtml('Worst Peak\u00a0(' + (pr.summary.worst_scenario||'ms') + ')', pr.summary.worst_peak_ms, 'danger')}
        </div>
      </div>
    </div>
    <div style="${tableWrap}">
      <table id="tbl_pr_${uid}" style="width:100%;border-collapse:collapse;font-size:0.88rem;">
        <thead><tr>
          <th style="${thStyle}">Scenario</th><th style="${thStyle}">Priority</th>
          <th style="${thStyle}">Users/Load</th><th style="${thStyle}">Avg Resp (ms)</th>
          <th style="${thStyle}">Peak Resp (ms)</th><th style="${thStyle}">Error Rate</th><th style="${thStyle}">Result</th>
        </tr></thead>
        <tbody>${(pr.rows||[]).map(r => `<tr>
          <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;font-weight:600;">${r.scenario}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;">${r.priority}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;">${r.users_load}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;">${r.avg_response}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;">${r.peak_response}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;">${r.error_rate}%</td>
          <td style="padding:8px 12px;border-bottom:1px solid #e2e8f0;">${tag(r.result||'—', (r.result||'').toLowerCase()==='pass')}</td>
        </tr>`).join('')}</tbody>
      </table>
    </div>`;
  } else {
    html += `<div style="padding:16px;border:1px dashed #d8e0eb;border-radius:12px;color:#667085;background:#fafcff;margin-top:10px;">Upload the Performance Excel to include load-test evidence, response times and failure markers.</div>`;
  }
  html += `</div>`;

  // ── MANAGEMENT SUMMARY ──────────────────────────────────────────
  {
    const today = new Date().toLocaleDateString('en-GB', { day:'2-digit', month:'long', year:'numeric' });
    // Build narrative lines
    const lines = [];
    if (result.has_tfs_data) {
      lines.push(`Total QA items tracked this period: <b>${s.total || 0}</b> (Bugs Created by QA: <b>${s.bugs || 0}</b>, Bugs Retested: <b>${s.retesting || 0}</b>, User Stories in QA: <b>${s.stories || 0}</b>${s.other ? `, Other: <b>${s.other}</b>` : ''}).`);
      const activeRow = rows.find(r => r.category === 'Bugs Created By QA');
      if (activeRow && activeRow.active > 0)
        lines.push(`<b>${activeRow.active}</b> bugs created by QA are still active and require attention.`);
    }
    if (vr) {
      lines.push(`Vertical testing covered <b>${vr.summary.total_verticals}</b> verticals across <b>${vr.summary.total_questions}</b> questions with an average similarity score of <b>${vr.summary.avg_similarity}%</b>. Best performing vertical: <b>${vr.summary.top_vertical}</b> at <b>${vr.summary.top_similarity}%</b>.`);
    }
    if (ar) {
      lines.push(`Automation coverage stands at <b>${ar.summary.overall_coverage}%</b> overall — <b>${ar.summary.automated_total}</b> of <b>${ar.summary.tfs_total}</b> TFS cases automated across <b>${ar.summary.module_count}</b> modules.`);
    }
    if (pr) {
      const failTxt = pr.summary.failure_count > 0 ? `<b style="color:#b42318;">${pr.summary.failure_count} failure(s)</b> recorded` : `<b style="color:#0f766e;">no failures</b> recorded`;
      lines.push(`Performance validation ran <b>${pr.summary.run_count}</b> load scenarios — ${failTxt}. Worst peak response: <b>${pr.summary.worst_peak_ms} ms</b> (${pr.summary.worst_scenario}).`);
    }

    html += `<div id="dash-mgmt-${uid}" style="${sectionStyle}">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px;">
        <div style="font-size:1.25rem;font-weight:700;color:#14213d;">Management Summary</div>
        <button class="dash-copy-btn" id="dash-copy-${uid}" onclick="(function(){
          const el=document.getElementById('dash-mgmt-body-${uid}');
          const txt=el?el.innerText:'';
          navigator.clipboard.writeText(txt).then(()=>{
            showToast('✅ Summary copied to clipboard');
            const b=document.getElementById('dash-copy-${uid}');
            if(b){const tip=b.querySelector('.dash-tip');if(tip)tip.textContent='Copied!';setTimeout(()=>{if(tip)tip.textContent='Copy summary';},2000);}
          });
        })()"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle;margin-right:4px;"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg><span class="dash-tip">Copy summary</span></button>
      </div>
      <div style="display:grid;grid-template-columns:300px minmax(0,1fr);gap:18px;align-items:start;margin-top:16px;">
        <div style="border-radius:18px;padding:18px;background:linear-gradient(180deg,#14b8a6,#0f766e);color:white;">
          <div style="font-size:1.2rem;font-weight:800;margin-bottom:8px;">Management Ready</div>
          <div style="color:rgba(255,255,255,0.84);line-height:1.55;font-size:0.88rem;margin-bottom:16px;">This section is formatted for quick executive review and can be copied or exported together with the full dashboard for sharing.</div>
          <span style="display:inline-block;padding:8px 12px;border-radius:999px;background:rgba(255,255,255,0.14);font-weight:700;font-size:0.85rem;">QA Status Report · ${today}</span>
          ${result.has_tfs_data ? `<div style="margin-top:10px;font-size:0.8rem;color:rgba(255,255,255,0.7);">Total: ${s.total||0} · Bugs: ${s.bugs||0} · Retesting: ${s.retesting||0} · Stories: ${s.stories||0}</div>` : ''}
        </div>
        <div id="dash-mgmt-body-${uid}" style="border:1px solid #d8e0eb;border-radius:18px;padding:18px;background:linear-gradient(180deg,#ffffff,#fbfdff);">
          ${lines.length ? lines.map(l => `<p style="margin:0 0 12px;line-height:1.65;font-size:0.9rem;color:#1e293b;">${l}</p>`).join('') : '<p style="margin:0;color:#667085;font-size:0.9rem;">Run the dashboard with TFS queries and/or Excel uploads to populate the management summary.</p>'}
        </div>
      </div>
    </div>`;
  }

  // ── AI ANALYSIS ─────────────────────────────────────────────────
  if (result.ai_analysis) {
    html += `<div id="dash-ai-section-${uid}" style="${sectionStyle}background:linear-gradient(180deg,#faf5ff,#f5f3ff);">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
        <div style="font-size:1.25rem;font-weight:700;color:#6d28d9;">🤖 AI Strategic Analysis</div>
        <div style="display:flex;gap:6px;">
          <button class="dash-copy-btn" id="dash-ai-copy-${uid}" onclick="(function(){
            const el=document.getElementById('dash-ai-body-${uid}');
            const txt=el?el.innerText:'';
            navigator.clipboard.writeText(txt).then(()=>{
              showToast('✅ AI analysis copied to clipboard');
              const b=document.getElementById('dash-ai-copy-${uid}');
              if(b){const tip=b.querySelector('.dash-tip');if(tip)tip.textContent='Copied!';setTimeout(()=>{if(tip)tip.textContent='Copy analysis';},2000);}
            });
          })()" style="background:#f3e8ff;color:#6b21a8;"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle;margin-right:4px;"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg><span class="dash-tip">Copy analysis</span></button>
          <button class="dash-chart-btn" onclick="window._dashDownloadAI('dash-ai-section-${uid}')" title="Download analysis as PNG" style="background:#f3e8ff;color:#6b21a8;border:1px solid #d8b4fe;width:30px;height:30px;display:flex;align-items:center;justify-content:center;border-radius:6px;cursor:pointer;"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle;"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/></svg></button>
        </div>
      </div>
      <div class="ai-analysis-content" id="dash-ai-body-${uid}" style="white-space:pre-wrap;">${result.ai_analysis}</div>
    </div>`;
  }

  outputEl.innerHTML = html;

  // global chart copy / download helpers
  window._dashDownloadChart = (cid) => {
    const c = document.getElementById(cid);
    if (!c) return;
    
    try {
      // Create temporary canvas to add white background (prevents black background on transparency)
      const tempCanvas = document.createElement('canvas');
      tempCanvas.width = c.width;
      tempCanvas.height = c.height;
      const ctx = tempCanvas.getContext('2d');
      
      // Fill white background
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, tempCanvas.width, tempCanvas.height);
      
      // Draw original chart
      ctx.drawImage(c, 0, 0);
      
      const a = document.createElement('a');
      a.download = (cid.replace(/dash_/,'').replace(/_\d+$/,'') || 'chart') + '.png';
      a.href = tempCanvas.toDataURL('image/png');
      a.click();
    } catch (err) {
      console.error('Download failed:', err);
      // Fallback to simple download
      const a = document.createElement('a');
      a.download = 'chart.png';
      a.href = c.toDataURL('image/png');
      a.click();
    }
  };

  window._dashCopyChart = async (cid) => {
    const c = document.getElementById(cid);
    if (!c) return;
    
    // Find the parent panel (the div with panelStyle)
    const panel = c.closest('div[style*="border-radius:14px"]');
    
    try {
      if (!panel) throw new Error('Panel not found');

      // Hide buttons during capture
      const btns = panel.querySelectorAll('.dash-chart-btn');
      btns.forEach(b => b.style.visibility = 'hidden');

      const canvas = await html2canvas(panel, {
        scale: 2, // Better quality
        useCORS: true,
        backgroundColor: '#ffffff', // Force white background
        logging: false
      });

      // Restore buttons
      btns.forEach(b => b.style.visibility = 'visible');

      canvas.toBlob(async (blob) => {
        try {
          if (!window.ClipboardItem) {
            throw new Error('Clipboard API not supported');
          }
          const item = new ClipboardItem({ 'image/png': blob });
          await navigator.clipboard.write([item]);
          showToast('✅ Chart copied to clipboard!');
        } catch (e) {
          console.error('Clipboard write failed:', e);
          showToast('❌ Copy failed. Try right-click -> Copy Image', 'danger');
        }
      });
    } catch (err) {
      console.error('html2canvas capture failed:', err);
      // Final fallback: copy just the canvas
      c.toBlob(async (blob) => {
        try {
          const item = new ClipboardItem({ 'image/png': blob });
          await navigator.clipboard.write([item]);
          showToast('✅ Chart (canvas only) copied!');
        } catch (e) {
          showToast('❌ Copy failed', 'danger');
        }
      });
    }
  };

  window._dashDownloadAI = async (sectionId) => {
    const el = document.getElementById(sectionId);
    if (!el) return;
    try {
      // Temporarily add a class for clean capture
      el.classList.add('pdf-export-mode');
      
      // Hide buttons during capture
      const btns = el.querySelectorAll('button');
      btns.forEach(b => b.style.visibility = 'hidden');

      const canvas = await html2canvas(el, {
        scale: 2,
        useCORS: true,
        backgroundColor: '#faf5ff' // Match the gradient start
      });

      const link = document.createElement('a');
      link.download = `AI_Strategic_Analysis_${new Date().getTime()}.png`;
      link.href = canvas.toDataURL('image/png');
      link.click();
      
      // Restore
      btns.forEach(b => b.style.visibility = 'visible');
      el.classList.remove('pdf-export-mode');
      showToast('AI Analysis saved as Image', 'success');
    } catch (err) {
      console.error('AI capture failed:', err);
      showToast('Failed to capture AI analysis', 'danger');
    }
  };

  // ── RENDER CHARTS ────────────────────────────────────────────────
  if (typeof ChartDataLabels !== 'undefined') {
    Chart.register(ChartDataLabels);
  }
  Chart.defaults.font.family = '"Segoe UI", Arial, sans-serif';
  Chart.defaults.color = '#475467';
  Chart.defaults.borderColor = '#d8e0eb';

  // Sortable tables
  ['tbl_state_' + uid, 'tbl_vt_' + uid, 'tbl_ar_' + uid, 'tbl_pr_' + uid, 'bug-tbl-' + uid].forEach(makeSortable);

  // Distribution doughnut
  if (result.has_tfs_data && trend.labels) {
    try {
      new Chart(document.getElementById(`dash_trend_${uid}`), {
        type: 'doughnut',
        data: {
          labels: trend.labels,
          datasets: [{ data: trend.values,
            backgroundColor: ['#ef4444','#f59e0b','#2563eb','#94a3b8'], borderWidth: 0 }]
        },
        options: { responsive:true, maintainAspectRatio:false,
          plugins:{
            legend:{ position:'bottom', labels:{boxWidth:12,padding:10} },
            datalabels:{
              display:true,
              color:'#000',
              font:{ weight:'bold', size:11 },
              formatter:(v,ctx) => {
                const total = ctx.dataset.data.reduce((a,b)=>a+b,0);
                const pct = total ? Math.round(v/total*100) : 0;
                return pct > 5 ? v : '';
              }
            },
            tooltip:{ callbacks:{ label(ctx){ const total=ctx.dataset.data.reduce((a,b)=>a+b,0); const pct=total?Math.round(ctx.parsed/total*100):0; return ` ${ctx.label}: ${ctx.parsed} (${pct}%)`; } } }
          }
        }
      });
    } catch(e){}

    // Bug assignee bar — light multi-color, data labels on bars
    if ((bugC.assignee||{}).labels?.length) {
      try {
        const aLabels = bugC.assignee.labels.slice(0,12);
        const aValues = bugC.assignee.values.slice(0,12);
        new Chart(document.getElementById(`dash_bugAssignee_${uid}`), {
          type: 'bar',
          data: {
            labels: aLabels,
            datasets: [{ label:'Bugs', data: aValues,
              backgroundColor: palFor(aLabels.length), borderRadius:6, maxBarThickness:28 }]
          },
          options: { indexAxis:'y', responsive:true, maintainAspectRatio:false,
            plugins:{
              legend:{display:false},
              datalabels:{ anchor:'end', align:'end', formatter:v=>v, font:{size:11,weight:'bold'}, color:'#1e293b', clip:false }
            },
            scales:{ x:{display:false} } }
        });
      } catch(e){}
    }

    // Bug priority bar — light semantic colors, data labels
    if ((bugC.priority||{}).labels?.length && document.getElementById(`dash_bugPriority_${uid}`)) {
      try {
        const pColors = bugC.priority.labels.map(l => {
          const lc = (l||'').toLowerCase();
          if (lc.includes('critical')) return '#fca5a5';
          if (lc.includes('high'))     return '#fcd34d';
          if (lc.includes('medium'))   return '#86efac';
          return '#cbd5e1';
        });
        new Chart(document.getElementById(`dash_bugPriority_${uid}`), {
          type: 'bar',
          data: {
            labels: bugC.priority.labels,
            datasets: [{ label:'Bugs', data: bugC.priority.values, backgroundColor: pColors, borderRadius:6, maxBarThickness:28 }]
          },
          options: { indexAxis:'y', responsive:true, maintainAspectRatio:false,
            plugins:{
              legend:{display:false},
              datalabels:{ anchor:'end', align:'end', formatter:v=>v, font:{size:11,weight:'bold'}, color:'#1e293b', clip:false }
            },
            scales:{ x:{display:false} } }
        });
      } catch(e){}
    }

    // Bug state bar — palette colors, data labels
    if ((bugC.state||{}).labels?.length && document.getElementById(`dash_bugState_${uid}`)) {
      try {
        new Chart(document.getElementById(`dash_bugState_${uid}`), {
          type: 'bar',
          data: {
            labels: bugC.state.labels,
            datasets: [{ label:'Bugs', data: bugC.state.values,
              backgroundColor: palFor(bugC.state.labels.length), borderRadius:6, maxBarThickness:28 }]
          },
          options: { indexAxis:'y', responsive:true, maintainAspectRatio:false,
            plugins:{
              legend:{display:false},
              datalabels:{ anchor:'end', align:'end', formatter:v=>v, font:{size:11,weight:'bold'}, color:'#1e293b', clip:false }
            },
            scales:{ x:{display:false} } }
        });
      } catch(e){}
    }
  }

  // Vertical chart — per-bar colors, data labels on top
  if (vr && document.getElementById(`dash_vertical_${uid}`)) {
    try {
      new Chart(document.getElementById(`dash_vertical_${uid}`), {
        type: 'bar',
        data: {
          labels: vr.chart.labels,
          datasets: [{ label:'Similarity %', data: vr.chart.similarity,
            backgroundColor: palFor(vr.chart.labels.length), borderRadius:6, maxBarThickness:36 }]
        },
        options: { responsive:true, maintainAspectRatio:false,
          plugins:{
            legend:{display:false},
            datalabels:{ anchor:'end', align:'top', formatter:v=>v+'%', font:{size:10,weight:'bold'}, color:'#1e293b' }
          },
          scales:{ y:{ beginAtZero:true, suggestedMax:110 } } }
      });
    } catch(e){}
  }

  // Automation chart — per-bar colors, data labels
  if (ar && document.getElementById(`dash_auto_${uid}`)) {
    try {
      new Chart(document.getElementById(`dash_auto_${uid}`), {
        type: 'bar',
        data: {
          labels: ar.chart.labels,
          datasets: [{ label:'Coverage %', data: ar.chart.coverage,
            backgroundColor: palFor(ar.chart.labels.length), borderRadius:8, maxBarThickness:32 }]
        },
        options: { indexAxis:'y', responsive:true, maintainAspectRatio:false,
          plugins:{
            legend:{display:false},
            datalabels:{ anchor:'end', align:'end', formatter:v=>v+'%', font:{size:11,weight:'bold'}, color:'#1e293b', clip:false }
          },
          scales:{ x:{ display:false, beginAtZero:true, suggestedMax:120 } } }
      });
    } catch(e){}
  }

  // Performance chart — line with fill, no data labels
  if (pr && document.getElementById(`dash_perf_${uid}`)) {
    try {
      new Chart(document.getElementById(`dash_perf_${uid}`), {
        type: 'line',
        data: {
          labels: pr.chart.labels,
          datasets: [{ label:'Peak Response Time (ms)', data: pr.chart.peak_response,
            borderColor:'#b42318', backgroundColor:'rgba(180,35,24,0.14)',
            tension:0.25, fill:true }]
        },
        options: { responsive:true, maintainAspectRatio:false,
          plugins:{
            legend:{ position:'bottom' },
            datalabels:{
              display:true,
              align:'top',
              anchor:'end',
              color:'#b42318',
              font:{ weight:'bold', size:10 },
              formatter:(v) => v ? v : ''
            }
          },
          scales:{ y:{ beginAtZero:true } } }
      });
    } catch(e){}
  }

  // Update stats panel
  const sStatus = document.getElementById('s-status');
  const sItems  = document.getElementById('s-items');
  if (sStatus) sStatus.textContent = '✓';
  if (sItems)  sItems.textContent  = s.total || 0;
}

async function fetchIterationPathStep2(isAuto = false) {
  const iterationPathField = document.getElementById('iteration-path');
  if (!iterationPathField) {
    if (isAuto) addDebugLog('❌ Iteration field not found in DOM');
    return;
  }

  // Use the effective TFS config which checks both sessionStorage and modal fields
  const config = getEffectiveTFSConfig();
  
  if (isAuto) {
    console.log('🔍 [AUTO FETCH] Config check:', { 
      has_base_url: !!config?.base_url, 
      base_url_length: (config?.base_url || '').length 
    });
  }

  if (!config || !config.base_url) {
    if (isAuto) addDebugLog('⚠️ Iteration auto-load: TFS base URL not configured yet');
    return;
  }

  if (isAuto) {
    iterationPathField.placeholder = 'Loading iterations...';
    addDebugLog('🔄 Fetching all iteration paths...');
  }

  try {
    const response = await fetchWithTimeout(`${API_BASE}/tfs/fetch-iteration`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        base_url: config.base_url,
        username: config.username || '',
        password: config.password || '',
        pat_token: config.pat_token || ''
      })
    }, 20000);

    const data = await response.json();
    
    if (response.ok && data.success !== false) {
      const loaded = String(data.iteration_path || '').trim();
      if (loaded) {
        iterationPathField.value = loaded;
        cacheIterationPath(loaded);
        if (isAuto) addDebugLog(`✅ Latest iteration loaded: ${loaded}`);
      } else {
        if (isAuto) addDebugLog('ℹ️ No active iteration found in TFS');
        iterationPathField.value = '';
      }
      
      // [NEW] Also fetch the full list for dropdown
      await populateIterationDropdown(config);
    } else {
      const errMsg = data.message || data.detail || 'Unknown error';
      if (isAuto) addDebugLog(`⚠️ Failed to fetch iteration: ${errMsg}`);
      iterationPathField.value = '';
    }
  } catch (error) {
    if (isAuto) addDebugLog(`❌ Iteration fetch error: ${error.message}`);
    iterationPathField.value = '';
  }
  
  if (isAuto) {
    iterationPathField.placeholder = 'Start typing or click to select...';
  }
}

// [AGENT 1] Populate iteration dropdown with all available iterations
async function populateIterationDropdown(config) {
  const iterationList = document.getElementById('iteration-list');
  if (!iterationList) return;
  
  try {
    // Fetch all iterations from TFS using existing endpoint
    const response = await fetchWithTimeout(`${API_BASE}/tfs/iterations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        base_url: config.base_url,
        username: config.username || '',
        password: config.password || '',
        pat_token: config.pat_token || ''
      })
    }, 20000);

    const data = await response.json();
    
    if (response.ok && data.iterations && Array.isArray(data.iterations)) {
      let iterations = data.iterations;
      
      addDebugLog(`🔍 Raw iterations from API (first 3): ${iterations.slice(0, 3).map(i => i.path || i).join(' | ')}`);
      
      // Smart sort: by month (descending), then by sprint (descending)
      iterations = iterations.sort((a, b) => {
        const pathA = (a.path || a);
        const pathB = (b.path || b);
        
        // Primary sort: by month descending (April > March > Jan)
        const monthA = getMonthNumber(pathA);
        const monthB = getMonthNumber(pathB);
        
        if (monthB !== monthA) {
          return monthB - monthA; // Higher month first (descending)
        }
        
        // Secondary sort: by sprint number descending
        const sprintA = getSprintNumber(pathA);
        const sprintB = getSprintNumber(pathB);
        
        if (sprintB !== sprintA) {
          return sprintB - sprintA; // Higher sprint first
        }
        
        // Fallback: alphabetical descending
        return pathB.localeCompare(pathA);
      });
      
      addDebugLog(`✅ Sorted iterations (first 3): ${iterations.slice(0, 3).map(i => i.path || i).join(' | ')}`);
      addDebugLog(`📋 Total: ${iterations.length} iterations loaded (sorted by month DESC, then sprint DESC)`);
      
      // Store all iterations for filtering
      window.allIterations = iterations;
      
      // Pre-render all items ONCE and store as HTML
      window.fullIterationHTML = iterations.map(iter => {
        const path = iter.path || iter;
        // Escape for JS string: backslashes must be doubled for the inline onclick handler
        const iterPathEscaped = path.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '\\"');
        return `<div style="padding:8px;border-bottom:1px solid #f0f0f0;cursor:pointer;background:transparent;transition:background 0.15s;" onmouseover="this.style.background='#f5f5f5'" onmouseout="this.style.background='transparent'" onmousedown="event.preventDefault(); selectIteration('${iterPathEscaped}'); return false;">${path}</div>`;
      }).join('');
      
      // Display the pre-rendered list
      iterationList.innerHTML = window.fullIterationHTML;
    } else {
      addDebugLog('ℹ️ No iterations found or empty list');
      window.allIterations = [];
      window.fullIterationHTML = '<div style="padding:8px;color:#999;">No iterations available</div>';
      iterationList.innerHTML = window.fullIterationHTML;
    }
  } catch (error) {
    addDebugLog(`⚠️ Failed to load iterations: ${error.message}`);
    window.allIterations = [];
    window.fullIterationHTML = '<div style="padding:8px;color:#d32f2f;">Error loading iterations</div>';
    iterationList.innerHTML = window.fullIterationHTML;
  }
}

// [AGENT 1] Month to number converter for proper date sorting
function getMonthNumber(path) {
  const monthMap = {
    'january': 1, 'january ': 1, 'jan': 1, 'jan ': 1,
    'february': 2, 'february ': 2, 'feb': 2, 'feb ': 2,
    'march': 3, 'march ': 3, 'mar': 3, 'mar ': 3,
    'april': 4, 'april ': 4, 'apr': 4, 'apr ': 4,
    'may': 5, 'may ': 5,
    'june': 6, 'june ': 6, 'jun': 6, 'jun ': 6,
    'july': 7, 'july ': 7, 'jul': 7, 'jul ': 7,
    'august': 8, 'august ': 8, 'aug': 8, 'aug ': 8,
    'september': 9, 'september ': 9, 'sep': 9, 'sep ': 9,
    'october': 10, 'october ': 10, 'oct': 10, 'oct ': 10,
    'november': 11, 'november ': 11, 'nov': 11, 'nov ': 11,
    'december': 12, 'december ': 12, 'dec': 12, 'dec ': 12
  };
  
  const pathLower = path.toLowerCase();
  for (const [month, num] of Object.entries(monthMap)) {
    if (pathLower.includes(month)) {
      return num;
    }
  }
  return 0; // Unknown month
}

// [AGENT 1] Extract sprint number from iteration path
function getSprintNumber(path) {
  const match = path.match(/Sprint\s*(\d+)/i);
  return match ? parseInt(match[1]) : 0;
}
function showIterationDropdown() {
  const dropdown = document.getElementById('iteration-dropdown');
  const iterationList = document.getElementById('iteration-list');
  
  if (!dropdown || !iterationList) return;
  
  // Show pre-rendered full list instantly (no re-rendering)
  if (window.fullIterationHTML) {
    iterationList.innerHTML = window.fullIterationHTML;
    // Log first 3 items currently in dropdown
    const firstThree = window.allIterations.slice(0, 3).map(i => i.path || i).join(' | ');
    addDebugLog(`📂 Dropdown opened - first 3: ${firstThree}`);
  } else {
    iterationList.innerHTML = '<div style="padding:8px;color:#999;">Loading iterations...</div>';
    addDebugLog('⏳ Dropdown opened but list still loading...');
  }
  
  dropdown.style.display = 'block';
}

// [AGENT 1] Hide iteration dropdown
function hideIterationDropdown() {
  const dropdown = document.getElementById('iteration-dropdown');
  if (dropdown) {
    dropdown.style.display = 'none';
  }
}

// [AGENT 1] Filter iterations as user types (optimized)
function filterIterationDropdown(searchText) {
  const iterationList = document.getElementById('iteration-list');
  const dropdown = document.getElementById('iteration-dropdown');
  
  if (!iterationList || !window.allIterations) return;
  
  const search = searchText.toLowerCase().trim();
  
  // If empty search, show full list (already rendered)
  if (!search) {
    if (window.fullIterationHTML) {
      iterationList.innerHTML = window.fullIterationHTML;
    }
    if (dropdown) dropdown.style.display = 'block';
    return;
  }
  
  // Filter only when user is searching
  const filtered = window.allIterations.filter(iter => {
    const text = (iter.path || iter).toLowerCase();
    return text.includes(search);
  });
  
  if (dropdown) dropdown.style.display = 'block';
  
  // Render filtered items (only re-render on search)
  iterationList.innerHTML = filtered.length > 0 
    ? filtered.map(iter => {
        const iterPath = (iter.path || iter).replace(/'/g, "\\'").replace(/"/g, '\\"');
        return `<div style="padding:8px;border-bottom:1px solid #f0f0f0;cursor:pointer;background:transparent;transition:background 0.15s;" onmouseover="this.style.background='#f5f5f5'" onmouseout="this.style.background='transparent'" onmousedown="event.preventDefault(); selectIteration('${iterPath}'); return false;">${iter.path || iter}</div>`;
      }).join('')
    : '<div style="padding:8px;color:#999;">No matching iterations</div>';
}

// [AGENT 1] Select iteration from dropdown
function selectIteration(iterationPath) {
  const field = document.getElementById('iteration-path');
  if (field) {
    field.value = iterationPath;
    cacheIterationPath(iterationPath);
    addDebugLog(`✅ Iteration selected: ${iterationPath} (list order preserved)`);
    
    // Hide dropdown after selection - but keep sorted list intact
    const dropdown = document.getElementById('iteration-dropdown');
    if (dropdown) {
      dropdown.style.display = 'none';
    }
  }
}

async function fetchIterationListStep2() {
  const tfsConfigRaw = sessionStorage.getItem('tfs_config');
  let config = null;
  if (tfsConfigRaw) {
    config = JSON.parse(tfsConfigRaw);
  } else {
    const baseUrlEl = document.getElementById('tfs-base-url');
    const usernameEl = document.getElementById('tfs-username');
    const passwordEl = document.getElementById('tfs-password');
    const patTokenEl = document.getElementById('tfs-pat-token');
    config = {
      base_url: baseUrlEl ? (baseUrlEl.value || '').trim() : '',
      username: usernameEl ? (usernameEl.value || '').trim() : '',
      password: passwordEl ? (passwordEl.value || '').trim() : '',
      pat_token: patTokenEl ? (patTokenEl.value || '').trim() : ''
    };
  }

  if (!config || !config.base_url) {
    addDebugLog('Iteration list fetch skipped: TFS base URL missing');
    return;
  }

  try {
    const response = await fetchWithTimeout(`${API_BASE}/tfs/iterations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config)
    }, 20000);

    const data = await response.json();
    const wrap = document.getElementById('iteration-list-wrap');
    const select = document.getElementById('iteration-list-select');
    const field = document.getElementById('iteration-path');
    if (!wrap || !select || !field) return;

    const rows = Array.isArray(data.iterations) ? data.iterations : [];
    if (!response.ok || !rows.length) {
      addDebugLog(`Iteration list not available: ${data.message || 'No iterations found'}`);
      return;
    }

    select.innerHTML = rows.map((row) => {
      const tf = row.time_frame ? ` (${row.time_frame})` : '';
      return `<option value="${row.path}">${row.path}${tf}</option>`;
    }).join('');
    wrap.style.display = 'block';

    if (data.current_iteration) {
      select.value = data.current_iteration;
      field.value = data.current_iteration;
    } else {
      field.value = select.value || field.value;
    }
    addDebugLog(`Iteration list loaded (${rows.length})`);
  } catch (error) {
    addDebugLog(`Iteration list fetch error: ${error.message}`);
  }
}

function applyIterationSelection() {
  const select = document.getElementById('iteration-list-select');
  const field = document.getElementById('iteration-path');
  if (select && field) {
    field.value = select.value || '';
    cacheIterationPath(field.value || '');
  }
}

function cacheIterationPath(value) {
  try {
    sessionStorage.setItem('manual_iteration_path', (value || '').trim());
  } catch (e) {
    // Ignore storage errors.
  }
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }
}

function getEffectiveTFSConfig() {
  const rawTfs = sessionStorage.getItem('tfs_config');
  const tfsFromSession = rawTfs ? JSON.parse(rawTfs) : {};
  
  // Extract from modal fields (trim to remove whitespace)
  const baseUrlFromModal = (document.getElementById('tfs-base-url')?.value || '').trim();
  const usernameFromModal = (document.getElementById('tfs-username')?.value || '').trim();
  const passwordFromModal = (document.getElementById('tfs-password')?.value || '').trim();
  const patTokenFromModal = (document.getElementById('tfs-pat-token')?.value || '').trim();
  const taskUrlFromModal = (document.getElementById('tfs-task-url')?.value || '').trim();
  const testPlanUrlFromModal = (document.getElementById('tfs-test-plan-url')?.value || '').trim();
  
  // Extract from session (trim to be safe)
  const baseUrlFromSession = (tfsFromSession.base_url || '').trim();
  const usernameFromSession = (tfsFromSession.username || '').trim();
  const passwordFromSession = (tfsFromSession.password || '').trim();
  const patTokenFromSession = (tfsFromSession.pat_token || '').trim();
  const taskUrlFromSession = (tfsFromSession.task_url || '').trim();
  const testPlanUrlFromSession = (tfsFromSession.test_plan_url || '').trim();
  
  // Prefer modal values if non-empty, otherwise use session values
  return {
    base_url: baseUrlFromModal || baseUrlFromSession || '',
    username: usernameFromModal || usernameFromSession || '',
    password: passwordFromModal || passwordFromSession || '',
    pat_token: patTokenFromModal || patTokenFromSession || '',
    task_url: taskUrlFromModal || taskUrlFromSession || '',
    test_plan_url: testPlanUrlFromModal || testPlanUrlFromSession || ''
  };
}

function setDefaultPromptStep2(kind) {
  if (kind === 'functional') {
    const el = document.getElementById('functional-prompt');
    if (el) el.value = DEFAULT_FUNCTIONAL_PROMPT;
  } else if (kind === 'ui') {
    const el = document.getElementById('ui-prompt');
    if (el) el.value = DEFAULT_UI_PROMPT;
  }
}

function onTestModeChangeStep2() {
  const mode = (document.getElementById('testcase-mode')?.value || 'functional').toLowerCase();
  const functionalRow = document.getElementById('functional-prompt-row');
  const uiRow = document.getElementById('ui-prompt-row');
  const screenshotRow = document.getElementById('ui-screenshot-row');

  if (functionalRow) functionalRow.style.display = mode === 'ui' ? 'none' : 'block';
  if (uiRow) uiRow.style.display = mode === 'functional' ? 'none' : 'block';
  if (screenshotRow) screenshotRow.style.display = mode === 'functional' ? 'none' : 'block';
}

async function loadDefaultSOPStep2(forceReplace = false) {
  const sopEl = document.getElementById('sop-text');
  if (!sopEl) return;
  if (!forceReplace && (sopEl.value || '').trim()) return;

  if (forceReplace) showToast('⏳ Loading default SOP...');

  try {
    const response = await fetchWithTimeout(`${API_BASE}/testcase/default-sop`, {}, 15000);
    const data = await response.json();
    if (response.ok && data.success) {
      sopEl.value = data.sop_text || '';
      addDebugLog('Default TruDocs SOP loaded.');
      if (forceReplace) showToast('✅ Default SOP loaded');
    } else {
      addDebugLog(`Could not load default SOP: ${data.message || 'Unknown error'}`);
      if (forceReplace) showToast('❌ Failed to load default SOP', 'danger');
    }
  } catch (error) {
    addDebugLog(`Default SOP load error: ${error.message}`);
    if (forceReplace) showToast('❌ Load error: ' + error.message, 'danger');
  }
}

function initializeTestCaseConfigStep2() {
  testcaseUiScreenshotFiles = [];
  setDefaultPromptStep2('functional');
  setDefaultPromptStep2('ui');
  onTestModeChangeStep2();
  loadDefaultSOPStep2(false);
}

let storyChatHistory = [];

function openStoryChatModal(storyText, initialAnalysis) {
  // Clear history for new analysis
  storyChatHistory = [];
  if (initialAnalysis) {
    storyChatHistory.push({ role: 'assistant', content: initialAnalysis });
  }

  const modal = document.createElement('div');
  modal.id = 'story-chat-modal';
  modal.style.cssText = `
    position: fixed; inset: 0; background: rgba(15,23,42,0.7);
    display: flex; align-items: center; justify-content: center;
    z-index: 3000; padding: 20px; backdrop-filter: blur(4px);
  `;

  const box = document.createElement('div');
  box.style.cssText = `
    background: white; width: 100%; max-width: 800px; max-height: 90vh;
    border-radius: 16px; display: flex; flex-direction: column;
    box-shadow: 0 25px 50px -12px rgba(0,0,0,0.25); overflow: hidden;
  `;

  // Header
  const header = document.createElement('div');
  header.style.cssText = `
    padding: 16px 24px; border-bottom: 1px solid #e2e8f0;
    display: flex; justify-content: space-between; align-items: center;
    background: #f8fafc;
  `;
  header.innerHTML = `
    <div>
      <div style="font-size:1.1rem; font-weight:800; color:#1e293b;">🤖 User Story Strategy & Analysis</div>
      <div style="font-size:0.8rem; color:#64748b;">Review AI analysis and ask follow-up questions</div>
    </div>
    <button id="close-story-chat" style="background:none; border:none; font-size:20px; cursor:pointer; color:#94a3b8;">✕</button>
  `;

  // Chat Container
  const chatContainer = document.createElement('div');
  chatContainer.id = 'story-chat-messages';
  chatContainer.style.cssText = `
    flex: 1; overflow-y: auto; padding: 24px;
    display: flex; flex-direction: column; gap: 16px; background: #fff;
  `;

function addChatMessage(role, text) {
    const msg = document.createElement('div');
    const isUser = role === 'user';
    msg.className = isUser ? 'story-chat-msg user' : 'story-chat-msg assistant';
    msg.style.cssText = `
      max-width: 85%; padding: 14px 18px; border-radius: 18px;
      font-size: 0.95rem; line-height: 1.6; position: relative;
      margin-bottom: 8px;
      ${isUser ? 'align-self: flex-end; background: #0f766e; color: white; border-bottom-right-radius: 4px;' : 'align-self: flex-start; background: #f1f5f9; color: #1e293b; border-bottom-left-radius: 4px; border: 1px solid #e2e8f0;'}
    `;
    
    let html = text.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>').replace(/\n/g, '<br>');
    
    if (!isUser) {
      // Add copy button for assistant messages
      html += `
        <div style="margin-top:10px; border-top:1px solid #e2e8f0; padding-top:8px; display:flex; justify-content:flex-end;">
          <button onclick="copyToClipboard('${text.replace(/'/g, "\\'").replace(/\n/g, '\\n')}')" style="background:none; border:none; color:#64748b; font-size:12px; cursor:pointer; display:flex; align-items:center; gap:4px;">
            <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>
            Copy
          </button>
        </div>
      `;
    }
    
    msg.innerHTML = html;
    chatContainer.appendChild(msg);
    chatContainer.scrollTop = chatContainer.scrollHeight;
  }

  if (initialAnalysis) {
    addChatMessage('assistant', initialAnalysis);
  }

  // Footer / Input
  const footer = document.createElement('div');
  footer.style.cssText = `padding: 16px 24px; border-top: 1px solid #e2e8f0; background: #f8fafc;`;
  footer.innerHTML = `
    <div style="display:flex; gap:12px;">
      <textarea id="story-chat-input" placeholder="Ask a follow-up question... (e.g., 'What about edge cases for the login?')" style="
        flex: 1; padding: 10px 14px; border: 1px solid #cbd5e1; border-radius: 8px;
        font-size: 0.95rem; resize: none; height: 46px; outline: none; transition: border-color 0.2s;
      "></textarea>
      <button id="send-story-chat" style="
        padding: 0 20px; background: #0f766e; color: white; border: none;
        border-radius: 8px; font-weight: 600; cursor: pointer; transition: background 0.2s;
      ">Send</button>
    </div>
  `;

  box.appendChild(header);
  box.appendChild(chatContainer);
  box.appendChild(footer);
  modal.appendChild(box);
  document.body.appendChild(modal);

  const input = footer.querySelector('#story-chat-input');
  const sendBtn = footer.querySelector('#send-story-chat');
  const closeBtn = header.querySelector('#close-story-chat');

  closeBtn.onclick = () => modal.remove();
  modal.onclick = (e) => { if (e.target === modal) modal.remove(); };

  async function handleSend() {
    const question = input.value.trim();
    if (!question) return;

    input.value = '';
    input.style.height = '46px';
    addChatMessage('user', question);

    // Show typing indicator
    const typing = document.createElement('div');
    typing.style.cssText = 'align-self: flex-start; color: #64748b; font-size: 0.85rem; font-style: italic;';
    typing.textContent = 'AI is thinking...';
    chatContainer.appendChild(typing);
    chatContainer.scrollTop = chatContainer.scrollHeight;

    try {
      const tfs = getEffectiveTFSConfig();
      const llmCfg = getLLMConfig();
      const response = await fetchWithTimeout(`${API_BASE}/agent/testcase/chat-story`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          story_text: storyText,
          question: question,
          chat_history: storyChatHistory,
          tfs_config: tfs,
          llm_config: llmCfg || null
        })
      }, 60000);

      const data = await response.json();
      typing.remove();

      if (!response.ok || data.status === 'error') {
        addChatMessage('assistant', `❌ Error: ${data.error || 'Failed to get response'}`);
      } else {
        addChatMessage('assistant', data.reply);
        storyChatHistory.push({ role: 'user', content: question });
        storyChatHistory.push({ role: 'assistant', content: data.reply });
      }
    } catch (err) {
      typing.remove();
      addChatMessage('assistant', `❌ Error: ${err.message}`);
    }
  }

  sendBtn.onclick = handleSend;
  input.onkeydown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  input.focus();
}

async function analyzeUserStory() {
  const storyText = (document.getElementById('story-preview')?.value || '').trim();
  const resultEl = document.getElementById('story-analysis-result');
  const btn = document.getElementById('btn-analyze-story');
  
  if (!storyText) {
    showToast('❌ Please enter or fetch a user story first.', 'danger');
    return;
  }

  // Persistent feedback: Disable button and change text
  const originalHtml = btn.innerHTML;
  btn.innerHTML = '⏳ Analyzing Strategy...';
  btn.disabled = true;
  btn.style.opacity = '0.7';
  btn.style.cursor = 'not-allowed';

  showToast('⏳ Analyzing User Story Strategy...');

  try {
    const tfs = getEffectiveTFSConfig();
    const llmCfg = getLLMConfig();
    const response = await fetchWithTimeout(`${API_BASE}/agent/testcase/analyze-story`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        story_text: storyText,
        tfs_config: tfs,
        llm_config: llmCfg || null
      })
    }, 60000);

    const data = await response.json();
    if (!response.ok || data.status === 'error') {
      showToast(`❌ Error: ${data.error || data.message || 'Analysis failed.'}`, 'danger');
      return;
    }

    // Instead of showing inline, open the interactive modal
    openStoryChatModal(storyText, data.analysis || 'No analysis returned.');

  } catch (err) {
    showToast(`❌ Error: ${err.message}`, 'danger');
  } finally {
    // Restore button state
    btn.innerHTML = originalHtml;
    btn.disabled = false;
    btn.style.opacity = '1';
    btn.style.cursor = 'pointer';
  }
}

// [AGENT 2] Global state for user stories
window.allUserStories = [];
window.fullUserStoryHTML = '';

// [AGENT 2] Fetch user stories for dropdown
async function fetchUserStoriesForDropdownStep2() {
  const userStoryList = document.getElementById('user-story-list');
  const workItemInput = document.getElementById('work-item-id');
  
  if (!userStoryList) return;
  
  const config = getEffectiveTFSConfig();
  if (!config || !config.base_url) {
    addDebugLog('⚠️ User story auto-load: TFS base URL not configured yet');
    return;
  }

  addDebugLog('🔄 Fetching user stories for dropdown...');
  
  try {
    const response = await fetchWithTimeout(`${API_BASE}/tfs/work-items`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        base_url: config.base_url,
        username: config.username || '',
        password: config.password || '',
        pat_token: config.pat_token || ''
      })
    }, 30000);

    const data = await response.json();
    
    if (response.ok && data.work_items && Array.isArray(data.work_items)) {
      const workItems = data.work_items;
      window.allUserStories = workItems;
      
      addDebugLog(`✅ Total: ${workItems.length} user stories loaded`);
      
      // Pre-render all items ONCE
      window.fullUserStoryHTML = workItems.map(item => {
        const id = String(item.id);
        const title = (item.title || '').replace(/'/g, "&#39;").replace(/"/g, "&quot;");
        return `<div class="user-story-dropdown-item" 
                     style="padding:10px;border-bottom:1px solid #f0f0f0;cursor:pointer;background:transparent;transition:background 0.15s;" 
                     onmouseover="this.style.background='#f0f9ff'" 
                     onmouseout="this.style.background='transparent'" 
                     onmousedown="event.preventDefault(); selectUserStoryStep2('${id}', ''); return false;">
                  <div style="font-weight:600;color:#0f172a;font-size:0.85rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="${title}">${item.title}</div>
                  <div style="color:#64748b;font-size:0.8rem;">#${id}</div>
                </div>`;
      }).join('');
      
      userStoryList.innerHTML = window.fullUserStoryHTML;
    } else {
      addDebugLog('ℹ️ No user stories found or empty list');
      window.allUserStories = [];
      window.fullUserStoryHTML = '<div style="padding:10px;color:#999;">No user stories available</div>';
      userStoryList.innerHTML = window.fullUserStoryHTML;
    }
  } catch (error) {
    addDebugLog(`⚠️ Failed to load user stories: ${error.message}`);
    window.allUserStories = [];
    window.fullUserStoryHTML = '<div style="padding:10px;color:#d32f2f;">Error loading user stories</div>';
    userStoryList.innerHTML = window.fullUserStoryHTML;
  }
}

// [AGENT 2] Show user story dropdown
function showUserStoryDropdownStep2() {
  const dropdown = document.getElementById('user-story-dropdown');
  const userStoryList = document.getElementById('user-story-list');
  
  if (!dropdown || !userStoryList) return;
  
  if (window.fullUserStoryHTML) {
    userStoryList.innerHTML = window.fullUserStoryHTML;
  } else {
    userStoryList.innerHTML = '<div style="padding:10px;color:#999;">Loading user stories...</div>';
  }
  
  dropdown.style.display = 'block';
}

// [AGENT 2] Hide user story dropdown
function hideUserStoryDropdownStep2() {
  const dropdown = document.getElementById('user-story-dropdown');
  if (dropdown) {
    // Delay hiding to allow click events on items to fire
    setTimeout(() => {
      dropdown.style.display = 'none';
    }, 200);
  }
}

// [AGENT 2] Filter user stories
function filterUserStoryDropdownStep2(searchText) {
  const userStoryList = document.getElementById('user-story-list');
  const dropdown = document.getElementById('user-story-dropdown');
  
  if (!userStoryList || !window.allUserStories) return;
  
  const search = searchText.toLowerCase().trim();
  
  if (!search) {
    if (window.fullUserStoryHTML) {
      userStoryList.innerHTML = window.fullUserStoryHTML;
    }
    if (dropdown) dropdown.style.display = 'block';
    return;
  }
  
  const filtered = window.allUserStories.filter(item => {
    return String(item.id).includes(search) || (item.title || '').toLowerCase().includes(search);
  });
  
  if (dropdown) dropdown.style.display = 'block';
  
  userStoryList.innerHTML = filtered.length > 0 
    ? filtered.map(item => {
        const id = String(item.id);
        const title = (item.title || '').replace(/'/g, "&#39;").replace(/"/g, "&quot;");
        return `<div class="user-story-dropdown-item" 
                     style="padding:10px;border-bottom:1px solid #f0f0f0;cursor:pointer;background:transparent;transition:background 0.15s;" 
                     onmouseover="this.style.background='#f0f9ff'" 
                     onmouseout="this.style.background='transparent'" 
                     onmousedown="event.preventDefault(); selectUserStoryStep2('${id}', ''); return false;">
                  <div style="font-weight:600;color:#0f172a;font-size:0.85rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="${title}">${item.title}</div>
                  <div style="color:#64748b;font-size:0.8rem;">#${id}</div>
                </div>`;
      }).join('')
    : '<div style="padding:10px;color:#999;">No matching stories</div>';
  }
// [AGENT 2] Select user story
function selectUserStoryStep2(id, title) {
  const field = document.getElementById('work-item-id');
  if (field) {
    field.value = id;
    addDebugLog(`✅ User story selected: #${id}`);
    
    const dropdown = document.getElementById('user-story-dropdown');
    if (dropdown) {
      dropdown.style.display = 'none';
    }
    
    // Auto-fetch details after selection
    fetchUserStoryDetailsStep2();
  }
}

async function fetchUserStoryDetailsStep2() {
  const workItemId = parseInt(document.getElementById('work-item-id')?.value || '', 10);
  const previewEl = document.getElementById('story-preview');
  if (!workItemId || Number.isNaN(workItemId)) {
    if (previewEl) previewEl.value = 'Please enter a valid User Story ID.';
    return;
  }

  const tfs = getEffectiveTFSConfig();
  if (!tfs.base_url) {
    if (previewEl) previewEl.value = 'Please configure TFS first (Base URL required).';
    return;
  }

  if (previewEl) previewEl.value = 'Fetching user story details...';
  try {
    const response = await fetchWithTimeout(`${API_BASE}/testcase/story-details`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        work_item_id: workItemId,
        tfs_config: tfs
      })
    }, 20000);
    const data = await response.json();

    if (!response.ok || !data.success) {
      if (previewEl) previewEl.value = `Failed to fetch story: ${data.message || 'Unknown error'}`;
      addDebugLog(`Story fetch failed for ${workItemId}`);
      return;
    }

    const story = data.story || {};
    const summary = [
      `ID: ${story.id || workItemId}`,
      `Title: ${story.title || ''}`,
      `Type: ${story.work_item_type || ''}`,
      `State: ${story.state || ''}`,
      `Iteration: ${story.iteration_path || ''}`,
      '--------------------------------------------------',
      'DESCRIPTION:',
      '--------------------------------------------------',
      story.description || '(No description)',
      '',
      '--------------------------------------------------',
      'ACCEPTANCE CRITERIA:',
      '--------------------------------------------------',
      story.acceptance_criteria || '(No criteria)',
      '--------------------------------------------------'
    ].join('\n');
    if (previewEl) previewEl.value = summary;
    addDebugLog(`Fetched user story details for ID ${workItemId}`);
  } catch (error) {
    if (previewEl) previewEl.value = `Fetch error: ${error.message}`;
    addDebugLog(`Story fetch error: ${error.message}`);
  }
}

async function encodeFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
    reader.onerror = () => reject(new Error('Could not read screenshot file.'));
    reader.readAsDataURL(file);
  });
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderUIScreenshotFileList() {
  const listEl = document.getElementById('ui-screenshot-file-list');
  const actionsEl = document.getElementById('ui-screenshot-file-actions');
  if (!listEl) return;

  if (!testcaseUiScreenshotFiles.length) {
    listEl.style.display = 'none';
    listEl.innerHTML = '';
    if (actionsEl) actionsEl.style.display = 'none';
    return;
  }

  listEl.style.display = 'block';
  if (actionsEl) actionsEl.style.display = 'flex';
  listEl.innerHTML = testcaseUiScreenshotFiles.map((f, idx) => `
    <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;padding:6px 8px;border:1px solid #e2e8f0;border-radius:6px;margin-bottom:6px;background:#f8fafc;">
      <span style="font-size:12px;color:#334155;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:75%;">${escapeHtml(f.name)} (${Math.max(1, Math.round((f.size || 0) / 1024))} KB)</span>
      <button onclick="removeUIScreenshotFile(${idx})" style="padding:4px 8px;background:#fff;color:#b91c1c;border:1px solid #fecaca;border-radius:6px;cursor:pointer;font-size:12px;">Remove</button>
    </div>
  `).join('');
}

function onUIScreenshotFilesSelected() {
  const screenshotEl = document.getElementById('ui-screenshot');
  const files = screenshotEl && screenshotEl.files ? Array.from(screenshotEl.files) : [];
  testcaseUiScreenshotFiles = files;
  renderUIScreenshotFileList();
}

function removeUIScreenshotFile(index) {
  testcaseUiScreenshotFiles = testcaseUiScreenshotFiles.filter((_, i) => i !== index);
  renderUIScreenshotFileList();
  const screenshotEl = document.getElementById('ui-screenshot');
  if (screenshotEl && !testcaseUiScreenshotFiles.length) {
    screenshotEl.value = '';
  }
}

function clearUIScreenshotFiles() {
  testcaseUiScreenshotFiles = [];
  renderUIScreenshotFileList();
  const screenshotEl = document.getElementById('ui-screenshot');
  if (screenshotEl) screenshotEl.value = '';
}

function openLargeEditor(targetId, editorTitle) {
  const target = document.getElementById(targetId);
  if (!target) return;

  const existing = document.getElementById('large-editor-overlay');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = 'large-editor-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(15,23,42,0.55);display:flex;align-items:center;justify-content:center;z-index:2000;padding:20px;';

  overlay.innerHTML = `
    <div style="width:min(1100px,96vw);height:min(88vh,900px);background:#fff;border-radius:12px;display:flex;flex-direction:column;box-shadow:0 25px 50px rgba(2,6,23,0.35);">
      <div style="display:flex;justify-content:space-between;align-items:center;padding:12px 16px;border-bottom:1px solid #e2e8f0;">
        <strong style="font-size:16px;color:#0f172a;">${escapeHtml(editorTitle || 'Editor')}</strong>
        <button id="large-editor-close" style="background:none;border:none;font-size:24px;line-height:1;cursor:pointer;color:#64748b;">×</button>
      </div>
      <div style="padding:12px 16px;flex:1;display:flex;min-height:0;">
        <textarea id="large-editor-text" style="width:100%;height:100%;resize:none;border:1px solid #cbd5e1;border-radius:8px;padding:12px;font-size:14px;line-height:1.5;"></textarea>
      </div>
      <div style="display:flex;justify-content:flex-end;gap:8px;padding:12px 16px;border-top:1px solid #e2e8f0;background:#f8fafc;">
        <button id="large-editor-cancel" style="padding:8px 12px;border:1px solid #cbd5e1;background:#fff;border-radius:8px;cursor:pointer;">Cancel</button>
        <button id="large-editor-save" style="padding:8px 12px;border:none;background:#0f766e;color:#fff;border-radius:8px;cursor:pointer;">Apply</button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);
  const textEl = document.getElementById('large-editor-text');
  if (textEl) {
    textEl.value = target.value || '';
    textEl.focus();
  }

  const closeEditor = () => overlay.remove();
  document.getElementById('large-editor-close')?.addEventListener('click', closeEditor);
  document.getElementById('large-editor-cancel')?.addEventListener('click', closeEditor);
  document.getElementById('large-editor-save')?.addEventListener('click', () => {
    const nextValue = document.getElementById('large-editor-text')?.value || '';
    target.value = nextValue;
    target.dispatchEvent(new Event('input', { bubbles: true }));
    closeEditor();
  });
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeEditor();
  });
}

async function encodeFilesAsDataUrls(files) {
  const results = [];
  const names = [];
  if (!files || !files.length) {
    return { names, data: results };
  }
  for (const file of files) {
    if (!file) continue;
    names.push(file.name || '');
    // Keep payload bounded per image.
    const dataUrl = await encodeFileAsDataUrl(file);
    results.push((dataUrl || '').slice(0, 250000));
  }
  return { names, data: results };
}

function syncLocalSheetSelection() {
  const selectEl = document.getElementById('excel-sheet-select');
  const inputEl = document.getElementById('sheet-name');
  const manualEl = document.getElementById('sheet-name-manual');
  if (selectEl && inputEl) {
    inputEl.value = selectEl.value || '';
  }
  if (manualEl && inputEl) {
    manualEl.value = inputEl.value || '';
  }
}

function syncExcelManualSheet() {
  const manualEl = document.getElementById('sheet-name-manual');
  const inputEl = document.getElementById('sheet-name');
  if (manualEl && inputEl) {
    inputEl.value = manualEl.value || '';
  }
}

function syncProviderManualSheet(provider) {
  const manualEl = document.getElementById(`${provider}-sheet-manual-input`);
  const inputEl = document.getElementById(`${provider}-sheet`);
  if (manualEl && inputEl) {
    inputEl.value = manualEl.value || '';
  }
}

function getLatestSheetName(sheetNames) {
  if (!Array.isArray(sheetNames) || !sheetNames.length) return '';

  const parseDateScore = (name) => {
    if (!name) return null;
    const text = String(name).trim();

    // yyyy-mm-dd or yyyy/mm/dd
    let m = text.match(/(20\d{2})[-\/](\d{1,2})[-\/](\d{1,2})/);
    if (m) {
      const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
      if (!Number.isNaN(d.getTime())) return d.getTime();
    }

    // dd-mm-yyyy or dd/mm/yyyy
    m = text.match(/(\d{1,2})[-\/](\d{1,2})[-\/](20\d{2})/);
    if (m) {
      const d = new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
      if (!Number.isNaN(d.getTime())) return d.getTime();
    }

    // native parse fallback (e.g., Mar-2026, April 8 2026)
    const p = new Date(text);
    if (!Number.isNaN(p.getTime())) return p.getTime();

    return null;
  };

  let bestIdx = sheetNames.length - 1; // fallback: last sheet
  let bestScore = null;
  for (let i = 0; i < sheetNames.length; i += 1) {
    const score = parseDateScore(sheetNames[i]);
    if (score !== null && (bestScore === null || score > bestScore)) {
      bestScore = score;
      bestIdx = i;
    }
  }
  return sheetNames[bestIdx];
}

async function validateExcelFile() {
  const fileEl = document.getElementById('excel-file');
  const statusEl = document.getElementById('excel-status');
  const pickerEl = document.getElementById('excel-sheet-picker');
  const selectEl = document.getElementById('excel-sheet-select');
  const sheetInput = document.getElementById('sheet-name');

  if (!fileEl || !fileEl.files || !fileEl.files.length) {
    if (statusEl) statusEl.textContent = 'Please select a file first.';
    return;
  }

  if (statusEl) {
    statusEl.textContent = 'Loading sheets...';
    statusEl.style.color = '#374151';
  }
  if (pickerEl) pickerEl.style.display = 'none';

  const formData = new FormData();
  formData.append('file', fileEl.files[0]);

  try {
    const response = await fetch(`${API_BASE}/files/validate-excel-upload`, {
      method: 'POST',
      body: formData
    });
    const data = await response.json();

    if (!response.ok || !data.success || !data.accessible) {
      if (statusEl) {
        statusEl.textContent = `Not accessible: ${data.message || 'Unable to read file.'}`;
        statusEl.style.color = '#b91c1c';
      }
      return;
    }

    const sheets = Array.isArray(data.sheet_names) ? data.sheet_names : [];
    if (!sheets.length) {
      if (statusEl) {
        statusEl.textContent = 'No sheets detected in file.';
        statusEl.style.color = '#b91c1c';
      }
      return;
    }

    if (selectEl) {
      selectEl.innerHTML = sheets.map((sheet) => `<option value="${sheet}">${sheet}</option>`).join('');
    }
    if (pickerEl) pickerEl.style.display = 'block';
    const latest = getLatestSheetName(sheets);
    if (selectEl && latest) selectEl.value = latest;
    if (sheetInput) sheetInput.value = latest || sheets[0];
    const manualEl = document.getElementById('sheet-name-manual');
    const manualWrap = document.getElementById('excel-sheet-manual');
    if (manualEl) manualEl.value = latest || sheets[0];
    if (manualWrap) manualWrap.style.display = 'none';

    if (statusEl) {
      statusEl.textContent = `Loaded ${sheets.length} sheet(s).`;
      statusEl.style.color = '#166534';
    }
  } catch (error) {
    if (statusEl) {
      statusEl.textContent = `Error: ${error.message}`;
      statusEl.style.color = '#b91c1c';
    }
  }
}

// Auto-load the first/latest sheet when file is selected
async function autoLoadExcelSheet() {
  const fileEl = document.getElementById('excel-file');
  const statusEl = document.getElementById('excel-status');
  const pickerEl = document.getElementById('excel-sheet-picker');
  const selectEl = document.getElementById('excel-sheet-select');
  const sheetInput = document.getElementById('sheet-name');
  
  if (!fileEl || !fileEl.files || !fileEl.files.length) {
    if (statusEl) statusEl.textContent = 'Please select a file.';
    return;
  }

  if (statusEl) {
    statusEl.textContent = '⏳ Loading sheets...';
    statusEl.style.color = '#374151';
  }

  const formData = new FormData();
  formData.append('file', fileEl.files[0]);

  try {
    const response = await fetch(`${API_BASE}/files/validate-excel-upload`, {
      method: 'POST',
      body: formData
    });
    const data = await response.json();

    if (!response.ok || !data.success || !data.accessible) {
      if (statusEl) {
        statusEl.textContent = `❌ Error: ${data.message || 'Unable to read file.'}`;
        statusEl.style.color = '#b91c1c';
      }
      if (pickerEl) pickerEl.style.display = 'none';
      return;
    }

    const sheets = Array.isArray(data.sheet_names) ? data.sheet_names : [];
    if (!sheets.length) {
      if (statusEl) {
        statusEl.textContent = '❌ No sheets detected.';
        statusEl.style.color = '#b91c1c';
      }
      if (pickerEl) pickerEl.style.display = 'none';
      return;
    }

    // Single sheet: auto-select and hide picker
    if (sheets.length === 1) {
      const selectedSheet = sheets[0];
      if (sheetInput) sheetInput.value = selectedSheet;
      if (pickerEl) pickerEl.style.display = 'none';
      
      if (statusEl) {
        statusEl.textContent = `✅ Ready! Sheet: "${selectedSheet}" (1 sheet found)`;
        statusEl.style.color = '#166534';
      }
      return;
    }

    // Multiple sheets: show selector and auto-select latest
    if (selectEl) {
      selectEl.innerHTML = sheets.map((sheet) => `<option value="${sheet}">${sheet}</option>`).join('');
    }
    
    const latest = getLatestSheetName(sheets);
    const selectedSheet = latest || sheets[0];
    
    if (selectEl) selectEl.value = selectedSheet;
    if (sheetInput) sheetInput.value = selectedSheet;
    if (pickerEl) pickerEl.style.display = 'block';
    
    if (statusEl) {
      statusEl.textContent = `✅ Loaded ${sheets.length} sheets. Selected: "${selectedSheet}"`;
      statusEl.style.color = '#166534';
    }
  } catch (error) {
    if (statusEl) {
      statusEl.textContent = `❌ Error: ${error.message}`;
      statusEl.style.color = '#b91c1c';
    }
    if (pickerEl) pickerEl.style.display = 'none';
  }
}

function syncSheetSelection(provider) {
  const selectEl = document.getElementById(`${provider}-sheet-select`);
  const inputEl = document.getElementById(`${provider}-sheet`);
  if (selectEl && inputEl) {
    inputEl.value = selectEl.value || '';
  }
}

function setDriveStatus(provider, message, kind = 'info') {
  const statusEl = document.getElementById(`${provider}-status`);
  if (!statusEl) return;

  statusEl.textContent = message;
  if (kind === 'success') {
    statusEl.style.color = '#166534';
  } else if (kind === 'error') {
    statusEl.style.color = '#b91c1c';
  } else {
    statusEl.style.color = '#374151';
  }
}

async function validateDriveLink(provider) {
  const urlEl = document.getElementById(`${provider}-url`);
  const tokenEl = document.getElementById(`${provider}-token`);
  const pickerEl = document.getElementById(`${provider}-sheet-picker`);
  const selectEl = document.getElementById(`${provider}-sheet-select`);
  const inputEl = document.getElementById(`${provider}-sheet`);

  if (!urlEl || !urlEl.value.trim()) {
    setDriveStatus(provider, 'Please paste a share link first.', 'error');
    return;
  }

  setDriveStatus(provider, 'Checking link accessibility...', 'info');
  if (pickerEl) pickerEl.style.display = 'none';

  try {
    const response = await fetch(`${API_BASE}/files/validate-drive-link`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider,
        file_url: urlEl.value.trim(),
        access_token: tokenEl ? (tokenEl.value || '').trim() : ''
      })
    });

    const data = await response.json();
    if (!response.ok || !data.success || !data.accessible) {
      setDriveStatus(provider, `Not accessible: ${data.message || 'Unable to read this link.'}`, 'error');
      addDebugLog(`${provider} link validation failed`);
      return;
    }

    const sheets = Array.isArray(data.sheet_names) ? data.sheet_names : [];
    if (!sheets.length) {
      setDriveStatus(provider, 'Accessible, but no sheets were detected.', 'error');
      addDebugLog(`${provider} accessible but no sheets found`);
      return;
    }

    if (selectEl) {
      selectEl.innerHTML = sheets.map(sheet => `<option value="${sheet}">${sheet}</option>`).join('');
    }
    const latest = getLatestSheetName(sheets);
    if (selectEl && latest) selectEl.value = latest;
    if (inputEl) inputEl.value = latest || sheets[0];
    if (pickerEl) {
      pickerEl.style.display = 'block';
    }
    const manualEl = document.getElementById(`${provider}-sheet-manual-input`);
    const manualWrap = document.getElementById(`${provider}-sheet-manual`);
    if (manualEl) manualEl.value = latest || sheets[0];
    if (manualWrap) manualWrap.style.display = 'none';

    setDriveStatus(provider, `Accessible. Loaded ${sheets.length} sheet(s).`, 'success');
    addDebugLog(`${provider} link is accessible and sheets were loaded`);
  } catch (error) {
    setDriveStatus(provider, `Validation error: ${error.message}`, 'error');
    addDebugLog(`${provider} validation error: ${error.message}`);
  }
}
// ==================== Panel Navigation ====================

function showPanel(panelId) {
  document.querySelectorAll('.panel').forEach(panel => {
    panel.classList.remove('active');
  });
  
  const panel = document.getElementById(panelId);
  if (panel) {
    panel.classList.add('active');
  }
}

function updateStepIndicator(step) {
  document.querySelectorAll('.step-item').forEach((item, index) => {
    if (index + 1 === step) {
      item.classList.add('active');
    } else {
      item.classList.remove('active');
    }
  });
}

function goHome() {
  showPanel('panel-agent-select');
  updateStepIndicator(1);
  currentAgent = null;
  
  // Reset agent selection UI
  document.querySelectorAll('.agent-card').forEach(card => {
    card.style.background = '';
    card.style.borderColor = '';
  });
  
  const continueBtn = document.getElementById('btn-continue');
  if (continueBtn) {
    continueBtn.disabled = true;
    continueBtn.textContent = 'Select an agent to continue →';
  }
  
  addDebugLog('🏠 Navigated to home page');
  updateConfigurationStatus();
}

function goBack() {
  showPanel('panel-agent-select');
  updateStepIndicator(1);
  addDebugLog('↩️ Returned to agent selection');
  updateConfigurationStatus();
}

// Helper: Poll execution status until complete
async function pollExecution(execId, executionStartedAt, setProgress) {
  let finalStatus = null;
  const maxAttempts = 120; // ~4 minutes
  let lastProgress = 0;
  
  for (let i = 0; i < maxAttempts; i++) {
    const pct = Math.min(95, 40 + Math.floor((i / maxAttempts) * 55));
    if (pct > lastProgress) {
      setProgress(pct, `Creating tasks... ${pct}%`);
      lastProgress = pct;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const statusResp = await fetchWithTimeout(`${API_BASE}/execution/${execId}/status`, {}, 30000);
    const statusData = await statusResp.json();
    if (statusData.status === 'completed') {
      finalStatus = statusData;
      addDebugLog(`✅ Task execution completed after ${(i + 1) * 2} seconds`);
      break;
    }
    if (statusData.status === 'error') {
      throw new Error(statusData.error || 'Task execution failed.');
    }
    if (i % 20 === 0 && i > 0) {
      addDebugLog(`⏳ Still creating tasks... (${(i + 1) * 2}s elapsed)`);
    }
  }
  
  if (!finalStatus) {
    throw new Error('Timed out while waiting for task execution (exceeded 4 minutes).');
  }
  
  setProgress(100, 'Execution completed.');
  addDebugLog('Execution completed for task agent');
  
  showPanel('panel-results');
  updateStepIndicator(4);
  renderExecutionResult(finalStatus.result || finalStatus, executionStartedAt);
}

// Helper: Handle execution errors
function handleExecutionError(error) {
  setProgress(0, 'Execution failed');
  addDebugLog(`❌ Execution error: ${error.message}`);
  showPanel('panel-execution');
  setTimeout(() => {
    alert(`❌ Error: ${error.message}`);
    showPanel('panel-config');
  }, 500);
}

function toggleWIType(type) {
  const bugFields = document.getElementById('bug-specific-fields');
  const featureFields = document.getElementById('feature-specific-fields');
  const lblBugDesc = document.getElementById('lbl-bug-desc');
  const chatInput = document.getElementById('bug-description-chat');
  const labelBug = document.getElementById('label-type-bug');
  const labelFeature = document.getElementById('label-type-feature');

  if (type === 'Bug') {
    if (bugFields) bugFields.style.display = 'block';
    if (featureFields) featureFields.style.display = 'none';
    if (lblBugDesc) lblBugDesc.textContent = 'Describe the Issue';
    if (chatInput) chatInput.placeholder = 'Describe what happened in plain English...';
    if (labelBug) labelBug.style.borderColor = 'var(--accent)';
    if (labelFeature) labelFeature.style.borderColor = 'var(--border)';
  } else {
    if (bugFields) bugFields.style.display = 'none';
    if (featureFields) featureFields.style.display = 'block';
    if (lblBugDesc) lblBugDesc.textContent = 'Describe the Feature';
    if (chatInput) chatInput.placeholder = 'Describe the feature you need and its benefit...';
    if (labelBug) labelBug.style.borderColor = 'var(--border)';
    if (labelFeature) labelFeature.style.borderColor = 'var(--accent)';
  }
}

async function formatWithAI() {
  const description = document.getElementById('bug-description-chat').value.trim();
  const wiType = document.querySelector('input[name="wi-type"]:checked')?.value || 'Bug';
  
  if (!description) {
    alert(`⚠️ Please enter a ${wiType} description`);
    return;
  }

  const btn = document.getElementById('btn-format-ai');
  const originalText = btn.innerHTML;
  btn.innerHTML = '✨ Processing with AI...';
  btn.disabled = true;

  try {
    const response = await fetch(`${API_BASE}/agent/format-bug-report`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        bug_description: description,
        work_item_type: wiType,
        llm_config: getLLMConfig()
      })
    });

    const result = await response.json();
    if (result.success && result.data) {
      const data = result.data;
      document.getElementById('bug-title-val').value = data.title || '';
      document.getElementById('bug-desc-val').value = data.description || '';
      
      if (wiType === 'Bug') {
        document.getElementById('bug-repro-val').value = data.reproduction_steps || '';
        document.getElementById('bug-severity').value = data.severity || '2 - High';
      } else {
        document.getElementById('feature-value-val').value = data.expected_behavior || '';
      }
      
      document.getElementById('bug-priority').value = data.priority || '1';
      
      addDebugLog(`✅ AI structured the ${wiType} details`);
    } else {
      throw new Error(result.message || 'Formatting failed');
    }
  } catch (err) {
    addDebugLog(`❌ AI Formatting error: ${err.message}`);
    alert(`AI Formatting failed: ${err.message}`);
  } finally {
    btn.innerHTML = originalText;
    btn.disabled = false;
  }
}

async function executeAgent() {
  if (!currentAgent) {
    addDebugLog('No agent selected for execution');
    console.error('No agent selected');
    return;
  }

  const progMsg = document.getElementById('prog-msg');
  const progFill = document.getElementById('prog-fill');
  const outputContent = document.getElementById('output-content');
  const setProgress = (pct, msg) => {
    if (progFill) progFill.style.width = `${pct}%`;
    if (progMsg) progMsg.textContent = msg;
    // Activate progress steps based on percentage
    const steps = [document.getElementById('ps-1'), document.getElementById('ps-2'), document.getElementById('ps-3'), document.getElementById('ps-4')];
    steps.forEach(s => s && s.classList.remove('active'));
    if (pct >= 10)  steps[0] && steps[0].classList.add('active');
    if (pct >= 30)  steps[1] && steps[1].classList.add('active');
    if (pct >= 60)  steps[2] && steps[2].classList.add('active');
    if (pct >= 90)  steps[3] && steps[3].classList.add('active');
  };

  addDebugLog(`Starting execution of ${currentAgent}`);
  
  // ==================== GLOBAL UI CLEANUP BEFORE EXECUTION ====================
  // Reset Global Result Variables
  parsedTestCases = [];
  testCaseCount = 0;

  // Reset Result Tabs & Panels to prevent data leakage between agents
  const elementsToClear = ['output-content', 'details-content', 'logs-content', 'dashboard-content'];
  elementsToClear.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = '';
  });

  // Hide the Dashboard tab by default (it's only for Agent 5)
  const dashTabBtn = document.getElementById('tab-btn-dashboard');
  if (dashTabBtn) dashTabBtn.style.display = 'none';

  // Hide the Analysis Chat and Upload sections (they're only for Agent 2)
  const testcaseAnalysisChatSection = document.getElementById('testcase-analysis-chat-section');
  if (testcaseAnalysisChatSection) testcaseAnalysisChatSection.style.display = 'none';
  const testcaseUploadSection = document.getElementById('testcase-upload-section');
  if (testcaseUploadSection) testcaseUploadSection.style.display = 'none';

  // Reset Stats Bar
  const statsToReset = { 's-status': '-', 's-items': '-', 's-duration': '-', 'results-meta': '' };
  Object.keys(statsToReset).forEach(id => {
    const el = document.getElementById(id);
    if (el) el.textContent = statsToReset[id];
  });
  if (document.getElementById('s-items-bar')) document.getElementById('s-items-bar').style.width = '0%';
  if (document.getElementById('s-duration-bar')) document.getElementById('s-duration-bar').style.width = '0%';

  // Switch to Output tab by default
  const outputTabBtn = document.getElementById('tab-btn-output');
  if (outputTabBtn) setResultsTab('output', outputTabBtn);

  showPanel('panel-execution');
  updateStepIndicator(3);
  const executionStartedAt = Date.now();

  try {
    setProgress(10, 'Validating inputs...');

    // ==================== AGENT 1: TFS Task Agent ====================
    if (currentAgent === 'task-creation') {
      const bulkMode = document.querySelector('input[name="bulk-mode"]:checked')?.value || 'create';
      const excelFileInput = document.getElementById('excel-file');
      const excelFile = excelFileInput?.files?.[0];
      const iterationPath = (document.getElementById('iteration-path')?.value || '').trim();
      const tfs = getEffectiveTFSConfig();
      
      // Validate Excel file is provided
      if (!excelFile) {
        throw new Error('Please upload an Excel file to proceed with bulk task processing.');
      }
      
      addDebugLog(`📋 Agent 1 Bulk Mode: ${bulkMode.toUpperCase()} | File: ${excelFile.name}`);
      
      // Debug log to show what config we got
      addDebugLog(`🔍 TFS Config Check - Base URL: ${tfs.base_url ? '✅' : '❌'}, PAT: ${tfs.pat_token ? '✅' : '❌'}, Username: ${tfs.username ? '✅' : '❌'}`);
      
      // Validate required TFS fields
      if (!tfs.base_url) {
        addDebugLog(`❌ Missing required field: Base URL`);
        throw new Error('Please configure TFS: Base URL required.');
      }
      
      const hasPATAuth = tfs.pat_token && tfs.pat_token.trim();
      const hasBasicAuth = tfs.username && tfs.password;
      
      if (!hasPATAuth && !hasBasicAuth) {
        addDebugLog(`❌ Missing authentication: Provide either PAT token OR (Username + Password)`);
        throw new Error('Please configure TFS: Provide either PAT token OR (Username + Password).');
      }
      
      setProgress(35, `Starting bulk ${bulkMode} operation...`);
      const llmConfigRaw = sessionStorage.getItem('llm_config');
      const llmConfig = llmConfigRaw ? JSON.parse(llmConfigRaw) : null;
      
      // Build TFS config with proper null handling
      const tfsConfig = {
        base_url: tfs.base_url,
        username: tfs.username || null,
        password: tfs.password || null,
        pat_token: tfs.pat_token || null,
        task_url: tfs.task_url || null,
        test_plan_url: tfs.test_plan_url || null
      };
      
      addDebugLog(`✅ TFS Config validated - using ${hasPATAuth ? 'PAT token' : 'username/password'} authentication`);
      
      // Read Excel file as base64 and handle submission
      const handleBulkFileSubmission = async (fileContent) => {
        try {
          const base64File = fileContent.split(',')[1] || fileContent;
          addDebugLog(`📤 Sending bulk ${bulkMode} request with Excel file...`);
          
          const startResp = await fetchWithTimeout(`${API_BASE}/agent/execute/tfs-task`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              work_item_id: bulkMode === 'update' ? 0 : null,
              task_description: null,
              iteration_path: iterationPath || null,
              batch_mode: true,
              excel_file: base64File,
              sheet_name: (document.getElementById('sheet-name-manual')?.value || document.getElementById('sheet-name')?.value || '').trim() || null,
              tfs_config: tfsConfig,
              llm_config: llmConfig
            })
          }, 30000);
          
          const startData = await startResp.json();
          if (!startResp.ok || !startData.execution_id) {
            const detailText = Array.isArray(startData.detail)
              ? startData.detail.map((d) => d.msg || JSON.stringify(d)).join('; ')
              : (startData.detail || '');
            throw new Error(startData.error || startData.message || detailText || `Failed to start task execution (HTTP ${startResp.status}).`);
          }
          
          await pollExecution(startData.execution_id, executionStartedAt, setProgress);
        } catch (error) {
          addDebugLog(`❌ Bulk processing error: ${error.message}`);
          handleExecutionError(error);
        }
      };
      
      const reader = new FileReader();
      reader.onload = (event) => {
        handleBulkFileSubmission(event.target.result);
      };
      
      reader.readAsDataURL(excelFile);
      return;
    }
    
    // ==================== AGENT 2: Test Case Agent ====================
    if (currentAgent === 'test-case') {
      const workItemId = parseInt(document.getElementById('work-item-id')?.value || '', 10);
      const storyDetails = (document.getElementById('story-preview')?.value || '').trim();
      const sopText = (document.getElementById('sop-text')?.value || '').trim();
      const testMode = (document.getElementById('testcase-mode')?.value || 'functional').trim().toLowerCase();
      const functionalPrompt = (document.getElementById('functional-prompt')?.value || '').trim();
      const uiPrompt = (document.getElementById('ui-prompt')?.value || '').trim();
      const tfs = getEffectiveTFSConfig();
      
      // Validate: Either User Story ID OR manual story details must be provided
      if ((!workItemId || Number.isNaN(workItemId)) && !storyDetails) {
        throw new Error('Please provide either a valid User Story ID or manually enter story details.');
      }
      
      if (!tfs.base_url) {
        throw new Error('Please configure TFS (Base URL) before running Agent 2.');
      }

      let uiScreenshotName = '';
      let uiScreenshotData = '';
      let uiScreenshotNames = [];
      let uiScreenshotDataList = [];
      if (testMode === 'ui' || testMode === 'both') {
        const files = Array.isArray(testcaseUiScreenshotFiles) ? testcaseUiScreenshotFiles : [];
        if (files.length) {
          const encoded = await encodeFilesAsDataUrls(files);
          uiScreenshotNames = encoded.names;
          uiScreenshotDataList = encoded.data;
          uiScreenshotName = uiScreenshotNames[0] || '';
          uiScreenshotData = uiScreenshotDataList[0] || '';
        }
      }

      setProgress(35, 'Starting test-case generation...');
      const llmConfigRaw = sessionStorage.getItem('llm_config');
      const llmConfig = llmConfigRaw ? JSON.parse(llmConfigRaw) : null;
      const coverageAnalysis = document.getElementById('coverage-analysis')?.checked || false;
      
      const startResp = await fetchWithTimeout(`${API_BASE}/agent/execute/testcase`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          work_item_id: workItemId || null,
          story_details: storyDetails || null,
          sop_text: sopText,
          test_mode: testMode,
          functional_prompt: functionalPrompt || DEFAULT_FUNCTIONAL_PROMPT,
          ui_prompt: uiPrompt || DEFAULT_UI_PROMPT,
          ui_screenshot_name: uiScreenshotName,
          ui_screenshot_data: uiScreenshotData,
          ui_screenshot_names: uiScreenshotNames,
          ui_screenshot_data_list: uiScreenshotDataList,
          tfs_config: tfs,
          llm_config: llmConfig,
          coverage_analysis: coverageAnalysis
        })
      }, 30000);
      const startData = await startResp.json();
      if (!startResp.ok || !startData.execution_id) {
        const detailText = Array.isArray(startData.detail)
          ? startData.detail.map((d) => d.msg || JSON.stringify(d)).join('; ')
          : (startData.detail || '');
        throw new Error(startData.error || startData.message || detailText || `Failed to start test-case execution (HTTP ${startResp.status}).`);
      }

      const execId = startData.execution_id;
      let finalStatus = null;
      const maxAttempts = 240; // ~8 minutes (was 120 = 4 minutes)
      let lastProgress = 0;
      
      for (let i = 0; i < maxAttempts; i++) {
        const pct = Math.min(95, 40 + Math.floor((i / maxAttempts) * 55));
        if (pct > lastProgress) {
          setProgress(pct, `Generating test cases... ${pct}%`);
          lastProgress = pct;
        }
        await new Promise((resolve) => setTimeout(resolve, 2000));
        const statusResp = await fetchWithTimeout(`${API_BASE}/execution/${execId}/status`, {}, 30000);
        const statusData = await statusResp.json();
        if (statusData.status === 'completed') {
          finalStatus = statusData;
          addDebugLog(`✅ Test case execution completed after ${(i + 1) * 2} seconds`);
          break;
        }
        if (statusData.status === 'error') {
          throw new Error(statusData.error || 'Test-case execution failed.');
        }
        if (i % 20 === 0 && i > 0) {
          addDebugLog(`⏳ Still generating test cases... (${(i + 1) * 2}s elapsed)`);
        }
      }

      if (!finalStatus) {
        throw new Error('Timed out while waiting for test-case execution (exceeded 8 minutes). AI may need more time or the request is too large.');
      }

      setProgress(100, 'Execution completed.');
      addDebugLog('Execution completed for test-case agent');
      
      // Store test case execution context for regeneration
      lastTestCaseExecutionData = {
        work_item_id: workItemId || null,
        story_details: storyDetails || null,
        sop_text: sopText,
        test_mode: testMode,
        functional_prompt: functionalPrompt || DEFAULT_FUNCTIONAL_PROMPT,
        ui_prompt: uiPrompt || DEFAULT_UI_PROMPT,
        ui_screenshot_name: uiScreenshotName,
        ui_screenshot_data: uiScreenshotData,
        ui_screenshot_names: uiScreenshotNames,
        ui_screenshot_data_list: uiScreenshotDataList,
        tfs_config: tfs,
        llm_config: llmConfig,
        coverage_analysis: coverageAnalysis
      };
      lastTestCaseResult = finalStatus.result || finalStatus;
      
      showPanel('panel-results');
      updateStepIndicator(4);
      renderExecutionResult(finalStatus.result || finalStatus, executionStartedAt);
      return;
    }

    // ==================== AGENT 3: Bug, Feature & User Story Creation Agent ====================
    if (currentAgent === 'bug-creation') {
      const wiType = bugAgentState.wiType;
      const bugTitle = (document.getElementById('wi-title')?.value || '').trim();
      const bugDescription = (document.getElementById('wi-description')?.value || '').trim();
      const areaPath = (document.getElementById('wi-area')?.value || '').trim();
      const iterationPath = (document.getElementById('wi-iteration')?.value || '').trim();
      const severity = (document.getElementById('wi-severity')?.value || '2 - High').trim();
      const priority = (document.getElementById('wi-priority')?.value || '2').trim();
      const assignedTo = (document.getElementById('wi-assigned')?.value || '').trim();
      const storyLink = (document.getElementById('wi-story-link')?.value || '').trim();
      const storyLinkId = document.getElementById('wi-story-link')?.getAttribute('data-id') || null;
      const tags = (document.getElementById('wi-tags')?.value || '').trim();
      
      const isUpdate = bugAgentState.updateMode;
      const workItemId = document.getElementById('update-work-item-id')?.value;

      if (!bugTitle) {
        throw new Error(`${wiType} title is required.`);
      }

      if (isUpdate && !workItemId) {
        throw new Error(`Work Item ID is required for update.`);
      }

      const tfs = getEffectiveTFSConfig();
      if (!tfs.base_url) {
        throw new Error('Please configure TFS (Base URL) before running Agent.');
      }

      setProgress(35, `${isUpdate ? 'Updating' : 'Creating'} ${wiType} in TFS...`);
      const llmConfigRaw = sessionStorage.getItem('llm_config');
      const llmConfig = llmConfigRaw ? JSON.parse(llmConfigRaw) : null;

      // ROBUST FIELD EXTRACTION: Line-by-line parser with proper section tracking
      let finalDesc = '';
      let finalRepro = ''; 
      let finalActual = '';
      let finalExpected = '';
      
      const lines = bugDescription.split('\n');
      
      // Helper: Check if a line is a field header
      function isFieldHeader(trimmed) {
          // Match keywords anywhere in the line and must end with optional punctuation/asterisks
          // This handles: "Steps to Reproduce:", "**Expected Result**", "Actual Result**", etc.
          const headerPatterns = [
              /^[\*\s]*(?:Steps?\s+to\s+Reproduce|Reproduction\s+Steps|How\s+to\s+Reproduce)/i,
              /^[\*\s]*(?:Actual\s+Result|Actual\s+Behavior|Current\s+Behavior)/i,
              /^[\*\s]*(?:Expected\s+Result|Expected\s+Behavior)/i,
              /^[\*\s]*(?:Description|Overview|Problem)/i,
              /^[\*\s]*(?:Steps|Repro|Reproduce|Actual|Current|Expected|What\s+Happens|Should\s+(?:Be|Happen))/i
          ];
          
          // Must be relatively short (headers are usually short)
          if (trimmed.length >= 80) return false;
          
          // Check against all patterns
          return headerPatterns.some(pattern => pattern.test(trimmed));
      }
      
      // Parse line by line
      let currentSection = null;
      let currentContent = [];
      
      for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          const trimmed = line.trim();
          
          if (!trimmed) {
              // Empty line - include in current content if we're in a section
              if (currentSection) currentContent.push('');
              continue;
          }
          
          if (isFieldHeader(trimmed)) {
              // Save previous section
              if (currentSection && currentContent.length > 0) {
                  const content = currentContent.map(l => l.trim()).filter(l => l).join('\n').trim();
                  if (content) {
                      if (currentSection === 'description') finalDesc = content;
                      else if (currentSection === 'steps') finalRepro = content;
                      else if (currentSection === 'actual') finalActual = content;
                      else if (currentSection === 'expected') finalExpected = content;
                  }
              }
              currentContent = [];
              
              // Determine new section from header text
              const headerLower = trimmed.toLowerCase();
              if (/steps?\s+to\s+reproduce|reproduction\s+steps|how\s+to\s+reproduce|^[\*\s]*steps/.test(headerLower)) {
                  currentSection = 'steps';
              } else if (/actual\s+result|actual\s+behavior|current\s+behavior|^[\*\s]*actual/.test(headerLower)) {
                  currentSection = 'actual';
              } else if (/expected\s+result|expected\s+behavior|^[\*\s]*expected/.test(headerLower)) {
                  currentSection = 'expected';
              } else if (/description|overview|problem/.test(headerLower)) {
                  currentSection = 'description';
              } else {
                  currentSection = null;
              }
          } else {
              // Regular content line
              if (currentSection) {
                  currentContent.push(line);
              } else if (!finalDesc && i === 0) {
                  // First line without header goes to description
                  finalDesc = trimmed;
                  currentSection = 'description';
              } else if (!currentSection && !finalDesc) {
                  // Before any headers, accumulate as description
                  if (!finalDesc) {
                      finalDesc = trimmed;
                  } else {
                      finalDesc += '\n' + trimmed;
                  }
              }
          }
      }
      
      // Save last section
      if (currentSection && currentContent.length > 0) {
          const content = currentContent.map(l => l.trim()).filter(l => l).join('\n').trim();
          if (content) {
              if (currentSection === 'description') finalDesc = content;
              else if (currentSection === 'steps') finalRepro = content;
              else if (currentSection === 'actual') finalActual = content;
              else if (currentSection === 'expected') finalExpected = content;
          }
      }
      
      // Last fallback: if everything is empty, use raw input
      if (!finalDesc && !finalRepro && !finalActual && !finalExpected) {
          finalDesc = bugDescription.trim();
      }

      console.log('📋 Formatted for Backend:', { finalDesc, finalRepro, finalActual, finalExpected });

      const bugResponse = await fetchWithTimeout(`${API_BASE}/agent/create-bug-tfs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          work_item_type: wiType,
          bug_title: bugTitle,
          description: finalDesc,
          reproduction_steps: finalRepro,
          expected_behavior: finalExpected,
          actual_behavior: finalActual,
          severity: severity,
          priority: priority,
          assigned_to: assignedTo,
          area_path: areaPath,
          iteration_path: iterationPath,
          related_work_item_id: storyLinkId || (storyLink.match(/\d+/) ? storyLink.match(/\d+/)[0] : null),
          work_item_id: workItemId,
          is_update: isUpdate,
          tags: tags,
          screenshots: bugAgentState.formScreenshots.map(s => ({ filename: s.name, data: s.data })),
          tfs_config: tfs,
          llm_config: llmConfig
        })
      }, 120000);

      setProgress(90, 'Finalizing...');
      const bugResult = await bugResponse.json();

      if (!bugResponse.ok || !bugResult.success) {
        throw new Error(bugResult.message || bugResult.error || `Failed to ${isUpdate ? 'update' : 'create'} ${wiType}`);
      }

      // Clear form screenshots after successful creation/update
      bugAgentState.formScreenshots = [];
      
      addDebugLog(`✅ Successfully ${isUpdate ? 'updated' : 'created'} ${wiType}: ${bugTitle}`);
      
      const finalStatus = {
        status: 'success',
        summary: { created: 1, total: 1, failed: 0 },
        agent: `Bug, Feature & User Story Agent (${wiType})`,
        report_rows: [{
          task_title: bugTitle,
          status: isUpdate ? 'Updated' : 'Created',
          task_id: bugResult.bug_id || bugResult.id,
          reason: 'Success'
        }]
      };
      
      setProgress(100, 'Execution completed.');
      showPanel('panel-results');
      updateStepIndicator(4);
      renderExecutionResult(finalStatus, executionStartedAt);
      return;
    }

    // ==================== AGENT 4: Dashboard Agent ====================
    if (currentAgent === 'dashboard') {
      const dashMode = document.querySelector('input[name="dash-mode"]:checked')?.value || 'static';
      const tfs = getEffectiveTFSConfig();

      if (!tfs.base_url && !tfs.task_url) throw new Error('TFS Base URL or Task URL is required.');
      const hasPAT = !!(tfs.pat_token && tfs.pat_token.trim());
      const hasUserPass = !!(tfs.username && tfs.username.trim() && tfs.password && tfs.password.trim());
      if (!hasPAT && !hasUserPass) throw new Error('Dashboard Agent requires authentication: PAT or Username/Password.');

      const bugQueryId   = document.getElementById('dash-bug-query')?.dataset?.queryId   || document.getElementById('dash-bug-query')?.value.trim()   || '';
      const retestQueryId= document.getElementById('dash-retest-query')?.dataset?.queryId || document.getElementById('dash-retest-query')?.value.trim() || '';
      const storyQueryId = document.getElementById('dash-story-query')?.dataset?.queryId  || document.getElementById('dash-story-query')?.value.trim()  || '';
      const otherQueryId = document.getElementById('dash-other-query')?.dataset?.queryId  || document.getElementById('dash-other-query')?.value.trim()  || '';
      const llmPrompt    = document.getElementById('dash-llm-prompt')?.value || '';

      setProgress(20, 'Reading Excel files...');
      const [verticalB64, automationB64, performanceB64] = await Promise.all([
        _fileToB64(document.getElementById('dash-vertical-excel')),
        _fileToB64(document.getElementById('dash-automation-excel')),
        _fileToB64(document.getElementById('dash-performance-excel')),
      ]);

      setProgress(40, `Fetching TFS data (${dashMode} mode)...`);
      const llmConfigRaw = sessionStorage.getItem('llm_config');
      const llmConfig = llmConfigRaw ? JSON.parse(llmConfigRaw) : null;

      const dashResp = await fetchWithTimeout(`${API_BASE}/dashboard/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tfs_config: {
            base_url: tfs.base_url || '',
            task_url: tfs.task_url || '',
            pat_token: tfs.pat_token || '',
            username: tfs.username || '',
            password: tfs.password || ''
          },
          llm_config: llmConfig,
          bug_query_id:    bugQueryId,
          retest_query_id: retestQueryId,
          story_query_id:  storyQueryId,
          other_query_id:  otherQueryId,
          vertical_excel_b64:    verticalB64,
          automation_excel_b64:  automationB64,
          performance_excel_b64: performanceB64,
          mode:       dashMode,
          llm_prompt: llmPrompt,
        })
      }, dashMode === 'ai' ? 180000 : 180000);

      if (!dashResp.ok) {
        const err = await dashResp.json().catch(() => ({}));
        throw new Error(err.detail || `Dashboard API error (HTTP ${dashResp.status})`);
      }

      const dashResult = await dashResp.json();
      setProgress(100, 'Dashboard ready.');

      showPanel('panel-results');
      updateStepIndicator(4);

      const duration = ((Date.now() - executionStartedAt) / 1000).toFixed(1);
      const sMeta = document.getElementById('results-meta');
      if (sMeta) sMeta.textContent = `Dashboard Agent · ${dashMode.toUpperCase()} mode · ${duration}s`;
      const sDur = document.getElementById('s-duration');
      if (sDur) sDur.textContent = `${duration}s`;

      // Show dashboard tab (reveal if hidden) and switch to it
      const dashTabBtn = document.getElementById('tab-btn-dashboard');
      if (dashTabBtn) dashTabBtn.style.display = '';
      renderDashboardResult(dashResult);
      setResultsTab('dashboard', dashTabBtn);

      // Put a brief summary in the Output tab too
      const outEl = document.getElementById('output-content');
      if (outEl) {
        const s = dashResult.summary || {};
        outEl.innerHTML = `<div style="padding:16px;font-family:monospace;font-size:0.88rem;color:#334155;">
<b>Dashboard generated in ${duration}s</b>

Mode  : ${dashMode.toUpperCase()}
Total : ${s.total ?? '—'}
Bugs  : ${s.bugs ?? '—'}
Retesting: ${s.retesting ?? '—'}
Stories  : ${s.stories ?? '—'}
Other    : ${s.other ?? '—'}

→ Switch to the 📊 Dashboard tab to view the full report.
</div>`;
      }

      addDebugLog(`✅ Dashboard generated (${dashMode}) in ${duration}s`);
      return;
    }

    if (currentAgent !== 'task-creation') {
      throw new Error('Unsupported agent selected.');
    }

    const iterationPathEl = document.getElementById('iteration-path');
    const iterationSelectEl = document.getElementById('iteration-list-select');
    let iterationPath = iterationPathEl ? (iterationPathEl.value || '').trim() : '';
    const selectedIteration = iterationSelectEl ? (iterationSelectEl.value || '').trim() : '';
    const cachedIteration = (sessionStorage.getItem('manual_iteration_path') || '').trim();

    if (!iterationPath && selectedIteration) {
      iterationPath = selectedIteration;
      if (iterationPathEl) iterationPathEl.value = selectedIteration;
    }

    if (!iterationPath && cachedIteration) {
      iterationPath = cachedIteration;
      if (iterationPathEl) iterationPathEl.value = cachedIteration;
    }

    // Keep latest value in storage so manual entry survives UI re-renders.
    cacheIterationPath(iterationPath);
    addDebugLog(`Iteration path selected for execution: ${iterationPath}`);

    const rawTfs = sessionStorage.getItem('tfs_config');
    const tfsFromSession = rawTfs ? JSON.parse(rawTfs) : {};
    const tfsFromModal = {
      base_url: (document.getElementById('tfs-base-url')?.value || '').trim(),
      username: (document.getElementById('tfs-username')?.value || '').trim(),
      password: (document.getElementById('tfs-password')?.value || '').trim(),
      pat_token: (document.getElementById('tfs-pat-token')?.value || '').trim()
    };

    // Prefer current modal values when present; fall back to session values.
    const tfs = {
      base_url: tfsFromModal.base_url || (tfsFromSession.base_url || '').trim(),
      username: tfsFromModal.username || (tfsFromSession.username || '').trim(),
      password: tfsFromModal.password || (tfsFromSession.password || '').trim(),
      pat_token: tfsFromModal.pat_token || (tfsFromSession.pat_token || '').trim()
    };

    if (!tfs.base_url || /:\/\/tfs-server(?::\d+)?\//i.test(tfs.base_url)) {
      throw new Error('TFS Base URL is still default. Please open TFS settings and save your real server URL.');
    }
    addDebugLog(`Using TFS Base URL: ${tfs.base_url}`);

    const excelSection = document.getElementById('section-excel');
    const onedriveSection = document.getElementById('section-onedrive');
    const gdriveSection = document.getElementById('section-gdrive');
    const usingExcel = !!(excelSection && excelSection.style.display !== 'none');
    const usingOneDrive = !!(onedriveSection && onedriveSection.style.display !== 'none');
    const usingGDrive = !!(gdriveSection && gdriveSection.style.display !== 'none');

    let result = null;
    setProgress(35, 'Preparing source file...');

    if (usingExcel) {
      const fileEl = document.getElementById('excel-file');
      const file = fileEl && fileEl.files ? fileEl.files[0] : null;
      if (!file) throw new Error('Please choose an Excel file before executing.');

      const sheetName = (document.getElementById('sheet-name')?.value || document.getElementById('sheet-name-manual')?.value || '').trim();

      const formData = new FormData();
      formData.append('file', file);
      formData.append('iteration_path', iterationPath);
      if (sheetName) formData.append('sheet_name', sheetName);
      formData.append('tfs_base_url', (tfs.base_url || '').trim());
      formData.append('tfs_username', (tfs.username || '').trim());
      formData.append('tfs_password', (tfs.password || '').trim());
      formData.append('tfs_pat_token', (tfs.pat_token || '').trim());
      formData.append('mode', bulkMode); // Added mode

      setProgress(60, `Creating tasks from uploaded Excel (${bulkMode})...`);
      const response = await fetchWithTimeout(`${API_BASE}/agent/execute/tfs-task/bulk-upload`, {
        method: 'POST',
        body: formData
      }, 120000);
      const responseText = await response.text();
      try {
        result = responseText ? JSON.parse(responseText) : {};
      } catch (e) {
        result = { status: 'error', error: responseText || `HTTP ${response.status}` };
      }
      if (!response.ok || result.status === 'error') {
        throw new Error(result.error || result.message || `Task creation failed (HTTP ${response.status}).`);
      }
    } else if (usingOneDrive || usingGDrive) {
      const provider = usingOneDrive ? 'onedrive' : 'gdrive';
      const fileUrl = (document.getElementById(`${provider}-url`)?.value || '').trim();
      const sheetName = (document.getElementById(`${provider}-sheet`)?.value || document.getElementById(`${provider}-sheet-manual-input`)?.value || '').trim();
      const accessToken = (document.getElementById(`${provider}-token`)?.value || '').trim();
      if (!fileUrl) throw new Error(`Please provide a ${provider === 'onedrive' ? 'OneDrive' : 'Google Drive'} link.`);

      setProgress(60, 'Downloading file and creating tasks...');
      const response = await fetchWithTimeout(`${API_BASE}/agent/execute/tfs-task/bulk-drive`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider,
          file_url: fileUrl,
          access_token: accessToken,
          iteration_path: iterationPath,
          sheet_name: sheetName || null,
          tfs_config: {
            base_url: (tfs.base_url || '').trim(),
            username: (tfs.username || '').trim(),
            password: (tfs.password || '').trim(),
            pat_token: (tfs.pat_token || '').trim()
          }
        })
      }, 120000);
      const responseText = await response.text();
      try {
        result = responseText ? JSON.parse(responseText) : {};
      } catch (e) {
        result = { status: 'error', error: responseText || `HTTP ${response.status}` };
      }
      if (!response.ok || result.status === 'error') {
        throw new Error(result.error || result.message || `Task creation failed (HTTP ${response.status}).`);
      }
    } else {
      throw new Error('No input method selected.');
    }

    setProgress(100, 'Task creation completed.');
    addDebugLog(`Execution completed: created=${result.summary?.created ?? 0}, failed=${result.summary?.failed ?? 0}`);

    showPanel('panel-results');
    updateStepIndicator(4);
    renderExecutionResult(result, executionStartedAt);
  } catch (error) {
    addDebugLog(`Execution failed: ${error.message}`);
    setProgress(100, 'Execution failed.');
    showPanel('panel-results');
    updateStepIndicator(4);
    renderExecutionResult({
      status: 'error',
      error: error.message,
      agent: currentAgent
    }, executionStartedAt);
  }
}

function renderExecutionResult(result, startedAtMs = null) {
  const outputContent = document.getElementById('output-content');
  const detailsContent = document.getElementById('details-content');
  const logsContent = document.getElementById('logs-content');
  const resultsMeta = document.getElementById('results-meta');
  
  // ==================== STATS BAR (Used by all agents) ====================
  const statusEl = document.getElementById('s-status');
  const itemsEl = document.getElementById('s-items');
  const durationEl = document.getElementById('s-duration');
  const itemsBar = document.getElementById('s-items-bar');
  const durationBar = document.getElementById('s-duration-bar');
  const testcaseAnalysisChatSection = document.getElementById('testcase-analysis-chat-section');

  const status = (result?.status || '').toLowerCase();
  const summary = result?.summary || {};
  const authMode = result?.auth_mode || 'unknown';
  
  // ==================== RESULT HANDLING BY AGENT ====================
  
  // [AGENT 2] Test Case Agent Result Handling
  // Detect if this is a test case result
  const isTestCaseAgent = currentAgent === 'test-case' || (result?.agent?.includes('Test Case') ?? false);
  
  let itemCount = 0;
  let testCaseData = [];
  
  if (isTestCaseAgent && result?.result) {
    // Parse markdown table to extract test cases
    const markdown = String(result.result || '');
    testCaseData = parseTestCasesFromMarkdown(markdown);
    parsedTestCases = testCaseData; // Store globally for upload
    itemCount = testCaseData.length;
    testCaseCount = itemCount;
    
    // Show analysis chat section for test cases
    if (testcaseAnalysisChatSection) {
      testcaseAnalysisChatSection.style.display = 'block';
      // Clear chat input
      const chatInput = document.getElementById('testcase-chat-input');
      if (chatInput) chatInput.value = '';
      // Clear chat container and reset
      clearTestCaseChat();
    }
  } else {
    // For task creation, use created count
    itemCount = Number(summary.created ?? result?.created_ids?.length ?? 0) || 0;
    
    // Hide analysis chat section and upload section for non-test-case results
    if (testcaseAnalysisChatSection) {
      testcaseAnalysisChatSection.style.display = 'none';
    }
    const uploadSection = document.getElementById('testcase-upload-section');
    if (uploadSection) {
      uploadSection.style.display = 'none';
    }
  }
  
  const failed = Number(summary.failed ?? 0) || 0;
  const skipped = Number(summary.skipped ?? 0) || 0;
  let total = Number(summary.total ?? result?.report_rows?.length ?? 0) || 0;
  if (isTestCaseAgent && itemCount > 0) total = itemCount;
  
  const durationSec = startedAtMs ? Math.max(1, Math.round((Date.now() - startedAtMs) / 1000)) : 0;

  if (outputContent) {
    if (isTestCaseAgent && testCaseData.length > 0) {
      // Display test cases in scrollable table format (10 visible, expand for more)
      outputContent.setAttribute('data-format', 'html');
      outputContent.innerHTML = generateTestCaseHTMLTableScrollable(testCaseData);
    } else {
      outputContent.removeAttribute('data-format');
      outputContent.textContent = JSON.stringify(result || {}, null, 2);
    }
  }

  if (statusEl) {
    if (status === 'success') statusEl.textContent = 'Success';
    else if (status === 'partial') statusEl.textContent = 'Partial';
    else statusEl.textContent = 'Failed';
  }
  if (itemsEl) itemsEl.textContent = String(itemCount);
  if (durationEl) durationEl.textContent = durationSec ? `${durationSec}s` : '-';
  if (itemsBar) {
    const pct = total > 0 ? Math.round((itemCount / total) * 100) : (status === 'success' ? 100 : 0);
    itemsBar.style.width = `${Math.max(8, Math.min(100, pct))}%`;
  }
  if (durationBar) durationBar.style.width = durationSec ? '100%' : '8%';
  
  // Update results meta
  let metaText = '';
  if (isTestCaseAgent) {
    metaText = `Test Cases Generated: ${itemCount} | Mode: ${(lastTestCaseExecutionData?.test_mode || 'functional').toUpperCase()} | Duration: ${durationSec}s`;
  } else {
    if (currentAgent === 'task-creation') {
        const createdCount = summary.created || 0;
        const updatedCount = summary.updated || 0;
        const failedCount = result?.failed_count || summary.failed || 0;
        const skippedCount = result?.skipped_count || summary.skipped || 0;
        const totalCount = result?.total || summary.total || (createdCount + updatedCount + failedCount + skippedCount);
        metaText = `Total: ${totalCount} | Created: ${createdCount} | Updated: ${updatedCount} | Failed: ${failedCount} | Skipped: ${skippedCount}`;
        lastTaskResult = result;
    } else {
        const itemCount = summary.created || summary.updated || 0;
        metaText = `Total: ${total} | Created/Updated: ${itemCount} | Failed: ${failed} | Skipped: ${skipped} | Auth: ${authMode}`;
    }
  }
  if (resultsMeta) resultsMeta.textContent = metaText;

  if (detailsContent) {
    if (isTestCaseAgent && testCaseData.length > 0) {
      // Display test cases as details
      const html = testCaseData.map((tc, idx) => `
        <div class="detail-row">
          <div class="detail-row-top">
            <div class="detail-title">#${idx + 1} ${tc.title}</div>
          </div>
          <div class="detail-meta">
            <strong>Steps:</strong><br/>
            ${(tc.steps || []).map((s, si) => `Step ${si + 1}: ${s.action}<br/>Expected: ${s.expected}<br/>`).join('')}
          </div>
        </div>
      `).join('');
      detailsContent.innerHTML = html;
    } else {
      const rows = Array.isArray(result?.report_rows) ? result.report_rows : [];
      if (!rows.length) {
        detailsContent.innerHTML = '<div style="color:#6b7280;">No detailed rows available.</div>';
      } else {
        const html = rows.map((r, idx) => {
          const id = r.task_id != null ? r.task_id : '-';
          const rawStatus = String(r.status || '-').toLowerCase();
          const statusClass = rawStatus === 'created' ? 'created' : (rawStatus === 'failed' ? 'failed' : 'skipped');
          const assignee = typeof r.assigned_to_tfs === 'object'
            ? (r.assigned_to_tfs.uniqueName || r.assigned_to_tfs.displayName || '-')
            : (r.assigned_to_tfs || '-');
          const dateText = r.start_date ? String(r.start_date).slice(0, 10) : '-';
          const reason = r.reason || '-';
          return `<div class="detail-row">
            <div class="detail-row-top">
              <div class="detail-title">#${idx + 1} ${r.task_title || '-'}</div>
              <div class="detail-pill ${statusClass}">${r.status || '-'}</div>
            </div>
            <div class="detail-meta">ID: ${id} | Assignee: ${assignee} | Hours: ${r.hours ?? '-'} | Date: ${dateText}</div>
            <div class="detail-meta">Reason: ${reason}</div>
          </div>`;
        }).join('');
        detailsContent.innerHTML = html;
      }
    }
  }

  if (logsContent) {
    const lines = [];
    lines.push(`status=${result?.status || 'unknown'}`);
    if (isTestCaseAgent) {
      lines.push(`test_mode=${lastTestCaseExecutionData?.test_mode || 'unknown'}`);
      lines.push(`test_cases_generated=${itemCount}`);
    } else {
      lines.push(`auth_mode=${authMode}`);
      lines.push(`created=${itemCount}, failed=${failed}, skipped=${skipped}, total=${total}`);
    }
    if (Array.isArray(result?.created_ids) && result.created_ids.length) {
      lines.push(`created_ids=${result.created_ids.join(', ')}`);
    }
    if (Array.isArray(result?.errors) && result.errors.length) {
      lines.push('errors:');
      result.errors.forEach((e) => lines.push(`- ${e}`));
    }
    logsContent.textContent = lines.join('\n');
  }
}
function parseTestCasesFromMarkdown(markdownText) {
  /**
   * Parse markdown table format into structured test cases
   * Format: 
   * | Title | Step Action | Step Expected |
   * | Test Case 1 | | |
   * | | First step action | First expected |
   * | | Second step action | Second expected |
   * | Test Case 2 | | |
   * | | First step action | First expected |
   */
  const lines = (markdownText || '').split('\n').map(l => l.trim());
  const testCases = [];
  let currentTestCase = null;
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    
    // Skip empty lines and separator lines
    if (!line || line.match(/^[\|\-\s]+$/)) continue;
    
    // Skip header row
    if (line.includes('Title') && line.includes('Step Action') && line.includes('Step Expected')) continue;
    
    // Parse table rows
    if (line.startsWith('|') && line.endsWith('|')) {
      const cells = line.split('|').map(c => c.trim());
      // Filter empty strings but keep index positions
      const titleCell = cells[1] || '';
      const actionCell = cells[2] || '';
      const expectedCell = cells[3] || '';
      
      // Check if this is a test case title row (first cell filled, other cells empty)
      if (titleCell && titleCell.length > 0 && actionCell === '' && expectedCell === '') {
        // Save previous test case if exists
        if (currentTestCase && currentTestCase.title) {
          testCases.push(currentTestCase);
        }
        
        // Clean title - remove [FUNC], [UI], [BOTH] prefixes
        const cleanTitle = cleanTestCaseTitle(titleCell);
        
        // Create new test case (no steps yet)
        currentTestCase = {
          title: cleanTitle,
          steps: []
        };
      } 
      // Check if this is a step row (first cell empty, has step action and expected)
      else if ((titleCell === '' || titleCell.length === 0) && (actionCell || expectedCell)) {
        if (currentTestCase) {
          currentTestCase.steps.push({
            action: actionCell || '',
            expected: expectedCell || ''
          });
        }
      }
    }
  }
  
  // Save the last test case
  if (currentTestCase && currentTestCase.title) {
    testCases.push(currentTestCase);
  }
  
  return testCases;
}

function cleanTestCaseTitle(title) {
  /**
   * Remove test type prefixes from title
   * E.g., "[FUNC] Title" -> "Title"
   * "[UI] Title" -> "Title"
   * "[BOTH] Title" -> "Title"
   */
  if (!title) return title;
  
  // Remove prefixes like [FUNC], [UI], [BOTH], [SECURITY], etc.
  return title.replace(/^\s*\[[A-Z0-9\s]+\]\s*/, '').trim();
}

function generateTestCaseHTMLTableScrollable(testCases) {
  /**
   * Generate scrollable table showing first 10 cases with expand option
   */
  if (!testCases || testCases.length === 0) {
    return '<div style="padding:16px;color:#666;">No test cases parsed.</div>';
  }
  
  const totalCases = testCases.length;
  const displayCases = testCases.slice(0, 10);
  const hasMore = totalCases > 10;
  
  let html = `<div style="padding:16px;background:#fff;">`;
  html += `<div style="margin-bottom:16px;display:flex;justify-content:space-between;align-items:center;">`;
  html += `<div style="font-size:16px;font-weight:600;color:#0f172a;">`;
  html += `📋 Test Cases: <span style="color:#0f766e;font-size:18px;">${totalCases}</span>`;
  if (hasMore) html += ` <span style="font-size:12px;color:#999;">(Showing 10 of ${totalCases})</span>`;
  html += `</div>`;
  if (hasMore) {
    html += `<button onclick="expandAllTestCases()" style="padding:6px 12px;background:#0ea5e9;color:white;border:none;border-radius:4px;cursor:pointer;font-size:0.85rem;font-weight:600;">📖 View All</button>`;
  }
  html += `</div>`;
  
  html += `<div style="max-height:500px;overflow-y:auto;border:1px solid #e2e8f0;border-radius:6px;">`;
  html += `<table style="width:100%;border-collapse:collapse;font-size:14px;">`;
  html += `<thead style="position:sticky;top:0;background:#f1f5f9;z-index:10;">`;
  html += `<tr style="border-bottom:2px solid #0f766e;">`;
  html += `<th style="padding:12px;text-align:left;font-weight:600;color:#0f172a;border-right:1px solid #cbd5e1;width:30%;">Title</th>`;
  html += `<th style="padding:12px;text-align:left;font-weight:600;color:#0f172a;border-right:1px solid #cbd5e1;width:35%;">Step Action</th>`;
  html += `<th style="padding:12px;text-align:left;font-weight:600;color:#0f172a;width:35%;">Step Expected</th>`;
  html += `</tr>`;
  html += `</thead>`;
  html += `<tbody>`;
  
  let rowCount = 0;
  displayCases.forEach((tc) => {
    const bgColor1 = rowCount % 2 === 0 ? '#ffffff' : '#f8fafc';
    html += `<tr style="background:${bgColor1};border-bottom:1px solid #e2e8f0;font-weight:600;">`;
    html += `<td style="padding:12px;border-right:1px solid #e2e8f0;color:#0f766e;">${escapeHtml(tc.title)}</td>`;
    html += `<td style="padding:12px;border-right:1px solid #e2e8f0;color:#999;"></td>`;
    html += `<td style="padding:12px;color:#999;"></td>`;
    html += `</tr>`;
    rowCount++;
    
    if (tc.steps && tc.steps.length > 0) {
      tc.steps.forEach((step) => {
        const bgColor = rowCount % 2 === 0 ? '#ffffff' : '#f8fafc';
        html += `<tr style="background:${bgColor};border-bottom:1px solid #e2e8f0;">`;
        html += `<td style="padding:12px;border-right:1px solid #e2e8f0;color:#999;"></td>`;
        html += `<td style="padding:12px;border-right:1px solid #e2e8f0;color:#374151;">${escapeHtml(step.action)}</td>`;
        html += `<td style="padding:12px;color:#374151;">${escapeHtml(step.expected)}</td>`;
        html += `</tr>`;
        rowCount++;
      });
    }
  });
  
  html += `</tbody></table></div>`;
  html += `</div>`;
  return html;
}

function expandAllTestCases() {
  /**
   * Show all test cases in expanded modal view
   */
  if (!parsedTestCases || parsedTestCases.length === 0) {
    addDebugLog('❌ No test cases to display');
    return;
  }

  const allHtml = generateTestCaseHTMLTable(parsedTestCases);
  const modal = document.createElement('div');
  modal.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0,0,0,0.5);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
    padding: 20px;
  `;

  const modalContent = document.createElement('div');
  modalContent.style.cssText = `
    background: white;
    border-radius: 12px;
    width: 90%;
    max-width: 1200px;
    max-height: 85vh;
    overflow-y: auto;
    box-shadow: 0 20px 60px rgba(0,0,0,0.3);
  `;

  const header = document.createElement('div');
  header.style.cssText = `
    padding: 20px;
    border-bottom: 2px solid #e2e8f0;
    display: flex;
    justify-content: space-between;
    align-items: center;
    background: #f8fafc;
    position: sticky;
    top: 0;
    z-index: 10;
  `;
  header.innerHTML = `<h2 style="margin:0;color:#0f172a;font-size:18px;">📋 All Test Cases (${parsedTestCases.length})</h2>`;

  const closeBtn = document.createElement('button');
  closeBtn.textContent = '✕';
  closeBtn.style.cssText = `
    background: none;
    border: none;
    font-size: 24px;
    cursor: pointer;
    color: #64748b;
  `;
  closeBtn.onclick = () => modal.remove();
  header.appendChild(closeBtn);

  const body = document.createElement('div');
  body.innerHTML = allHtml;

  modalContent.appendChild(header);
  modalContent.appendChild(body);
  modal.appendChild(modalContent);
  document.body.appendChild(modal);
  modal.onclick = (e) => {
    if (e.target === modal) modal.remove();
  };

  addDebugLog('📖 Expanded view opened');
}



function generateTestCaseHTMLTable(testCases) {
  /**
   * Generate a formatted HTML table display of test cases (full view)
   */
  if (!testCases || testCases.length === 0) {
    return '<div style="padding:16px;color:#666;">No test cases parsed.</div>';
  }
  
  let html = `<div style="padding:16px;background:#fff;">`;
  html += `<div style="margin-bottom:16px;font-size:16px;font-weight:600;color:#0f172a;">`;
  html += `📋 Total Test Cases: <span style="color:#0f766e;font-size:18px;">${testCases.length}</span>`;
  html += `</div>`;
  
  html += `<table style="width:100%;border-collapse:collapse;border:1px solid #e2e8f0;font-size:14px;">`;
  html += `📋 Total Test Cases Generated: <span style="color:#0f766e;font-size:18px;">${testCases.length}</span>`;
  html += `</div>`;
  
  html += `<table style="width:100%;border-collapse:collapse;border:1px solid #e2e8f0;font-size:14px;">`;
  html += `<thead>`;
  html += `<tr style="background:#f1f5f9;border-bottom:2px solid #0f766e;">`;
  html += `<th style="padding:12px;text-align:left;font-weight:600;color:#0f172a;border-right:1px solid #cbd5e1;width:30%;">Title</th>`;
  html += `<th style="padding:12px;text-align:left;font-weight:600;color:#0f172a;border-right:1px solid #cbd5e1;width:35%;">Step Action</th>`;
  html += `<th style="padding:12px;text-align:left;font-weight:600;color:#0f172a;width:35%;">Step Expected</th>`;
  html += `</tr>`;
  html += `</thead>`;
  html += `<tbody>`;
  
  let rowCount = 0;
  testCases.forEach((tc, tcIdx) => {
    // Row 1: Test case title row (title only, actions and expected empty)
    const bgColor1 = rowCount % 2 === 0 ? '#ffffff' : '#f8fafc';
    html += `<tr style="background:${bgColor1};border-bottom:1px solid #e2e8f0;font-weight:600;">`;
    html += `<td style="padding:12px;border-right:1px solid #e2e8f0;color:#0f766e;">${escapeHtml(tc.title)}</td>`;
    html += `<td style="padding:12px;border-right:1px solid #e2e8f0;color:#999;"></td>`;
    html += `<td style="padding:12px;color:#999;"></td>`;
    html += `</tr>`;
    rowCount++;
    
    // Rows 2+: Step rows (title empty, action and expected filled)
    if (tc.steps && tc.steps.length > 0) {
      tc.steps.forEach((step, stepIdx) => {
        const bgColor = rowCount % 2 === 0 ? '#ffffff' : '#f8fafc';
        html += `<tr style="background:${bgColor};border-bottom:1px solid #e2e8f0;">`;
        html += `<td style="padding:12px;border-right:1px solid #e2e8f0;color:#999;"></td>`;
        html += `<td style="padding:12px;border-right:1px solid #e2e8f0;color:#374151;vertical-align:top;">${escapeHtml(step.action)}</td>`;
        html += `<td style="padding:12px;color:#374151;vertical-align:top;">${escapeHtml(step.expected)}</td>`;
        html += `</tr>`;
        rowCount++;
      });
    } else {
      // Test case with no steps - add one empty step row
      const bgColor = rowCount % 2 === 0 ? '#ffffff' : '#f8fafc';
      html += `<tr style="background:${bgColor};border-bottom:1px solid #e2e8f0;">`;
      html += `<td style="padding:12px;border-right:1px solid #e2e8f0;color:#999;"></td>`;
      html += `<td style="padding:12px;border-right:1px solid #e2e8f0;color:#999;">-</td>`;
      html += `<td style="padding:12px;color:#999;">-</td>`;
      html += `</tr>`;
      rowCount++;
    }
  });
  
  html += `</tbody>`;
  html += `</table>`;
  html += `</div>`;
  
  return html;
}

function generateTestCaseTableDisplay(testCases) {
  /**
   * Generate a formatted text display of test cases (kept for reference/logs)
   */
  if (!testCases || testCases.length === 0) {
    return 'No test cases parsed.';
  }
  
  let output = `\n${'═'.repeat(100)}\n`;
  output += `TEST CASES GENERATED: ${testCases.length}\n`;
  output += `${'═'.repeat(100)}\n\n`;
  
  testCases.forEach((tc, idx) => {
    output += `Test Case #${idx + 1}: ${tc.title}\n`;
    output += `${'-'.repeat(80)}\n`;
    
    if (tc.steps && tc.steps.length > 0) {
      tc.steps.forEach((step, si) => {
        output += `  Step ${si + 1}:\n`;
        output += `    Action: ${step.action}\n`;
        output += `    Expected: ${step.expected}\n`;
      });
    }
    output += '\n';
  });
  
  return output;
}

async function regenerateTestCases() {
  if (!lastTestCaseExecutionData) {
    addDebugLog('No test case execution data available for regeneration');
    return;
  }
  
  const promptBox = document.getElementById('testcase-additional-prompt');
  const additionalPrompt = (promptBox?.value || '').trim();
  
  // Disable button while regenerating
  const btnRegenerate = event?.target;
  if (btnRegenerate) btnRegenerate.disabled = true;
  
  try {
    let newFunctionalPrompt = lastTestCaseExecutionData.functional_prompt;
    let newUiPrompt = lastTestCaseExecutionData.ui_prompt;
    
    // If user provided custom prompt, append it
    if (additionalPrompt) {
      newFunctionalPrompt += `\n\nADDITIONAL REQUEST FROM USER:\n${additionalPrompt}`;
      if (newUiPrompt) {
        newUiPrompt += `\n\nADDITIONAL REQUEST FROM USER:\n${additionalPrompt}`;
      }
      addDebugLog(`🔄 Regenerating test cases with custom prompt: "${additionalPrompt.substring(0, 50)}..."`);
    } else {
      addDebugLog('🔄 Regenerating test cases (same parameters)');
    }
    
    const progMsg = document.getElementById('prog-msg');
    const progFill = document.getElementById('prog-fill');
    const setProgress = (pct, msg) => {
      if (progFill) progFill.style.width = `${pct}%`;
      if (progMsg) progMsg.textContent = msg;
    };
    
    // Show execution panel progress
    showPanel('panel-execution');
    updateStepIndicator(3);
    setProgress(35, 'Regenerating test cases...');
    
    const startResp = await fetchWithTimeout(`${API_BASE}/agent/execute/testcase`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        work_item_id: lastTestCaseExecutionData.work_item_id,
        story_details: lastTestCaseExecutionData.story_details,
        sop_text: lastTestCaseExecutionData.sop_text,
        test_mode: lastTestCaseExecutionData.test_mode,
        functional_prompt: newFunctionalPrompt,
        ui_prompt: newUiPrompt,
        ui_screenshot_name: lastTestCaseExecutionData.ui_screenshot_name,
        ui_screenshot_data: lastTestCaseExecutionData.ui_screenshot_data,
        ui_screenshot_names: lastTestCaseExecutionData.ui_screenshot_names,
        ui_screenshot_data_list: lastTestCaseExecutionData.ui_screenshot_data_list,
        tfs_config: lastTestCaseExecutionData.tfs_config,
        llm_config: lastTestCaseExecutionData.llm_config,
        coverage_analysis: lastTestCaseExecutionData.coverage_analysis
      })
    }, 30000);
    
    const startData = await startResp.json();
    if (!startResp.ok || !startData.execution_id) {
      throw new Error('Failed to start regeneration');
    }
    
    const execId = startData.execution_id;
    let finalStatus = null;
    const maxAttempts = 120; // Increased from 60 (~4 minutes)
    let lastProgress = 0;
    
    for (let i = 0; i < maxAttempts; i++) {
      const pct = Math.min(95, 40 + Math.floor((i / maxAttempts) * 55));
      if (pct > lastProgress) {
        setProgress(pct, `Regenerating... ${pct}%`);
        lastProgress = pct;
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
      
      const statusResp = await fetchWithTimeout(`${API_BASE}/execution/${execId}/status`, {}, 30000);
      const statusData = await statusResp.json();
      
      if (statusData.status === 'completed') {
        finalStatus = statusData;
        addDebugLog(`✅ Regeneration completed after ${(i + 1) * 2} seconds`);
        break;
      }
      if (statusData.status === 'error') {
        throw new Error(statusData.error || 'Regeneration failed');
      }
      if (i % 10 === 0 && i > 0) {
        addDebugLog(`⏳ Still regenerating... (${(i + 1) * 2}s elapsed)`);
      }
    }
    
    if (!finalStatus) {
      throw new Error('Regeneration timed out (exceeded 4 minutes)');
    }
    
    setProgress(100, 'Regeneration completed');
    addDebugLog('✅ Regeneration completed - returning to results');
    
    lastTestCaseResult = finalStatus.result || finalStatus;
    showPanel('panel-results');
    renderExecutionResult(finalStatus.result || finalStatus);
    
  } catch (error) {
    addDebugLog(`❌ Regeneration failed: ${error.message}`);
    showPanel('panel-results');
  } finally {
    if (btnRegenerate) btnRegenerate.disabled = false;
  }
}

function clearTestCasePrompt() {
  const promptBox = document.getElementById('testcase-additional-prompt');
  if (promptBox) {
    promptBox.value = '';
    promptBox.focus();
  }
}

function resetAll() {
  currentAgent = null;
  lastTestCaseExecutionData = null;
  lastTestCaseResult = null;
  testCaseCount = 0;
  showPanel('panel-agent-select');
  updateStepIndicator(1);
  addDebugLog('🔄 Reset to initial state');
}

function newExecution() {
  // Reset execution state but keep the agent and config
  lastTestCaseExecutionData = null;
  lastTestCaseResult = null;
  testCaseCount = 0;
  testcaseUiScreenshotFiles = [];
  parsedTestCases = [];
  selectedTestCaseIndices = [];

  // === Clear Extracted Metadata ===
  extractedTfsProject = null;
  extractedTfsCollectionUrl = null;
  addDebugLog('🧹 Extracted TFS metadata cleared');
  ['output-content', 'details-content', 'logs-content', 'dashboard-content'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = '';
  });

  // Reset Stats Bar
  const statsToReset = { 's-status': '-', 's-items': '-', 's-duration': '-', 'results-meta': '' };
  Object.keys(statsToReset).forEach(id => {
    const el = document.getElementById(id);
    if (el) el.textContent = statsToReset[id];
  });
  if (document.getElementById('s-items-bar')) document.getElementById('s-items-bar').style.width = '0%';
  if (document.getElementById('s-duration-bar')) document.getElementById('s-duration-bar').style.width = '0%';

  // === Agent 1: Task Creation - clear inputs ===
  const excelFile = document.getElementById('excel-file');
  if (excelFile) excelFile.value = '';
  // Do NOT clear iteration path - preserve it for user convenience
  const iterationPath = document.getElementById('iteration-path');
  const cachedIteration = (sessionStorage.getItem('manual_iteration_path') || '').trim();
  if (iterationPath && !iterationPath.value && cachedIteration) {
    iterationPath.value = cachedIteration;
  }

  // === Agent 2: Test Case - clear inputs ===
  const workItemId = document.getElementById('work-item-id');
  if (workItemId) workItemId.value = '';
  const storyPreview = document.getElementById('story-preview');
  if (storyPreview) storyPreview.value = '';
  const sopText = document.getElementById('sop-text');
  if (sopText) sopText.value = '';

  // === Agent 3: Bug, Feature & User Story - clear all fields and state ===
  const wiTitle = document.getElementById('wi-title');
  if (wiTitle) wiTitle.value = '';
  const wiDescription = document.getElementById('wi-description');
  if (wiDescription) wiDescription.value = '';
  const wiArea = document.getElementById('wi-area');
  if (wiArea) wiArea.value = '';
  const wiIteration = document.getElementById('wi-iteration');
  if (wiIteration) wiIteration.value = '';
  const wiSeverity = document.getElementById('wi-severity');
  if (wiSeverity) wiSeverity.value = '2 - High';
  const wiPriority = document.getElementById('wi-priority');
  if (wiPriority) wiPriority.value = '2';
  const wiAssigned = document.getElementById('wi-assigned');
  if (wiAssigned) wiAssigned.value = '';
  const wiTags = document.getElementById('wi-tags');
  if (wiTags) wiTags.value = '';
  const wiStoryLink = document.getElementById('wi-story-link');
  if (wiStoryLink) { wiStoryLink.value = ''; wiStoryLink.removeAttribute('data-id'); }
  const updateWIId = document.getElementById('update-work-item-id');
  if (updateWIId) updateWIId.value = '';
  const fetchStatus = document.getElementById('fetch-status');
  if (fetchStatus) fetchStatus.textContent = '';

  // Clear chat messages and chat input
  const chatMessages = document.getElementById('bug-chat-messages');
  if (chatMessages) chatMessages.innerHTML = '';
  const chatInput = document.getElementById('bug-chat-input');
  if (chatInput) chatInput.value = '';

  // Reset bugAgentState
  bugTags = [];
  selectedScreenshots = [];
  bugAgentState.updateMode = false;
  bugAgentState.currentScreenshots = [];
  bugAgentState.formScreenshots = [];
  bugAgentState.history = [];
  bugAgentState.states = {
    'Bug': { workItemId: '', title: '', description: '', formScreenshots: [], history: [], chatHTML: '' },
    'Feature': { workItemId: '', title: '', description: '', formScreenshots: [], history: [], chatHTML: '' },
    'User Story': { workItemId: '', title: '', description: '', formScreenshots: [], history: [], chatHTML: '' }
  };

  // === Agent 5: Dashboard - clear query inputs and file inputs ===
  ['dash-bug-query','dash-retest-query','dash-story-query','dash-other-query'].forEach(id => {
    const el = document.getElementById(id);
    if (el) { el.value = ''; el.dataset.queryId = ''; }
  });
  ['dash-vertical-excel','dash-automation-excel','dash-performance-excel'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
    const nameEl = document.getElementById(id.replace('-excel','-name'));
    if (nameEl) nameEl.textContent = '📎 Click to upload .xlsx';
  });
  const dashPrompt = document.getElementById('dash-llm-prompt');
  // Preserve prompt instead of clearing it

  // Clear Dashboard Content UI
  const dashContent = document.getElementById('dashboard-content');
  if (dashContent) dashContent.innerHTML = '';
  const dashTabBtn = document.getElementById('tab-btn-dashboard');
  if (dashTabBtn) dashTabBtn.style.display = 'none';

  // === Agent 1: Task Creation - clear file inputs ===
  const taskExcel = document.getElementById('excel-file');
  if (taskExcel) taskExcel.value = '';
  const taskExcelStatus = document.getElementById('excel-status');
  if (taskExcelStatus) taskExcelStatus.textContent = '';
  const taskSheetPicker = document.getElementById('excel-sheet-picker');
  if (taskSheetPicker) taskSheetPicker.style.display = 'none';

  showPanel('panel-config');
  updateStepIndicator(2);
  addDebugLog(`🔄 Starting new execution with ${currentAgent} agent`);
}

function exportResults() {
  const isTestCaseAgent = currentAgent === 'test-case' && testCaseCount > 0;
  const isTaskAgent = currentAgent === 'task-creation' && lastTaskResult && lastTaskResult.report_rows && lastTaskResult.report_rows.length > 0;

  if (isTestCaseAgent) {
    // Export test cases as Excel
    exportTestCasesAsExcel();
  } else if (isTaskAgent) {
    // Export task creation results as Excel
    exportTasksAsExcel();
  } else {
    // Export other results as text
    console.log('Exporting results...');
    addDebugLog('⬇️ Exporting results to file');
    const output = document.getElementById('output-content');
    if (output && output.textContent) {
      const blob = new Blob([output.textContent], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'results.txt';
      a.click();
    }
  }
}

async function exportTasksAsExcel() {
  if (!lastTaskResult || !lastTaskResult.report_rows) {
    showToast('No task results to export', 'error');
    return;
  }

  showToast('Generating Tasks Excel...', 'info');
  addDebugLog('⬇️ Generating Tasks Excel result file');

  try {
    const response = await fetch(`${API_BASE}/agent/tfs-task/download-excel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        report_rows: lastTaskResult.report_rows,
        filename: `TFS_Tasks_Execution_${new Date().toISOString().split('T')[0]}.xlsx`
      })
    });

    if (!response.ok) throw new Error('Failed to generate Excel');

    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `TFS_Tasks_Execution_${new Date().toISOString().split('T')[0]}.xlsx`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast('Tasks Excel downloaded!', 'success');
  } catch (err) {
    console.error('Excel Export Error:', err);
    showToast('Failed to export Excel report', 'error');
  }
}
function exportTestCasesAsExcel() {
  /**
   * Export parsed test cases as Excel format
   * Creates a simple CSV that Excel can open directly
   */
  if (!testCaseCount || !lastTestCaseResult) {
    addDebugLog('No test cases to export');
    return;
  }
  
  try {
    // Parse test cases
    const markdown = String(lastTestCaseResult.result || '');
    const testCases = parseTestCasesFromMarkdown(markdown);
    
    if (testCases.length === 0) {
      addDebugLog('❌ No test cases found to export');
      return;
    }
    
    // Create CSV content with proper escaping
    // Format: Title | Step Action | Step Expected (matching the exact structure)
    let csv = 'Title,Step Action,Step Expected\n';
    
    testCases.forEach((tc, tcIdx) => {
      // Row 1: Test case title (Step Action and Step Expected empty)
      csv += `"${escapeCSV(tc.title)}","",""\n`;
      
      // Row 2+: Steps (Title empty, Step Action and Step Expected filled)
      if (tc.steps && tc.steps.length > 0) {
        tc.steps.forEach((step, stepIdx) => {
          const action = escapeCSV(step.action || '');
          const expected = escapeCSV(step.expected || '');
          csv += `"","${action}","${expected}"\n`;
        });
      }
    });
    
    // Create blob and download
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.setAttribute('href', url);
    link.setAttribute('download', `TestCases_${new Date().getTime()}.csv`);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    
    addDebugLog(`✅ Exported ${testCases.length} test cases to CSV`);
    
  } catch (error) {
    addDebugLog(`❌ Export failed: ${error.message}`);
  }
}

function escapeCSV(value) {
  /**
   * Escape special characters for CSV
   */
  if (!value) return '';
  const str = String(value);
  if (str.includes('"') || str.includes(',') || str.includes('\n')) {
    return str.replace(/"/g, '""');
  }
  return str;
}

function setResultsTab(tabName, btnEl = null) {
  document.querySelectorAll('.results-tab').forEach(tab => tab.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));

  const tab = document.getElementById(`tab-${tabName}`);
  if (tab) tab.classList.add('active');
  if (btnEl) btnEl.classList.add('active');

  // Handle dashboard download dropdown visibility
  const dashDownload = document.getElementById('download-dash-dropdown');
  if (dashDownload) {
    dashDownload.style.display = tabName === 'dashboard' ? 'block' : 'none';
  }

  addDebugLog(`Switched to ${tabName} tab`);
}

function filterResults() {
  const query = (document.getElementById('search-input')?.value || '').trim().toLowerCase();
  const detailRows = document.querySelectorAll('#details-content .detail-row');
  if (detailRows.length) {
    detailRows.forEach((row) => {
      const txt = (row.textContent || '').toLowerCase();
      row.style.display = !query || txt.includes(query) ? 'block' : 'none';
    });
    return;
  }

  const output = document.getElementById('output-content');
  const logs = document.getElementById('logs-content');
  [output, logs].forEach((el) => {
    if (!el) return;
    const txt = (el.textContent || '').toLowerCase();
    el.style.opacity = !query || txt.includes(query) ? '1' : '0.35';
  });
}
function toggleDebugPanel() {
  const panel = document.getElementById('debug-panel');
  if (panel) {
    panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
    addDebugLog(`Activity Log ${panel.style.display === 'block' ? 'expanded' : 'collapsed'}`);
  }
}

// ==================== Test Case Selection & Suite Upload ====================

function showTestCaseUploadUI() {
  if (!parsedTestCases || parsedTestCases.length === 0) {
    // Parse test cases from the result
    if (lastTestCaseResult) {
      const markdown = String(lastTestCaseResult.result || '');
      parsedTestCases = parseTestCasesFromMarkdown(markdown);
    }
  }

  // Hide chat section and show upload section
  const chatSection = document.getElementById('testcase-analysis-chat-section');
  const uploadSection = document.getElementById('testcase-upload-section');
  
  if (chatSection) chatSection.style.display = 'none';
  if (uploadSection) uploadSection.style.display = 'block';
  
  // Initialize the selection list
  initializeTestCaseSelectionList();
  addDebugLog(`📤 Upload UI shown with ${parsedTestCases.length} test cases`);
}

function initializeTestCaseSelectionList() {
  const listContainer = document.getElementById('testcase-selection-list');
  if (!listContainer || parsedTestCases.length === 0) return;

  // Create checkboxes for each test case
  let html = '';
  parsedTestCases.forEach((tc, idx) => {
    const isSelected = selectedTestCaseIndices.includes(idx);
    html += `
      <div style="padding:8px 12px;border-bottom:1px solid #e2e8f0;display:flex;align-items:center;gap:8px;">
        <input 
          type="checkbox" 
          id="tc-check-${idx}" 
          ${isSelected ? 'checked' : ''} 
          onchange="toggleTestCaseSelection(${idx})"
          style="cursor:pointer;width:18px;height:18px;"
        />
        <label for="tc-check-${idx}" style="cursor:pointer;flex:1;margin:0;font-size:0.9rem;">
          <strong>${escapeHtml(tc.title)}</strong>
          <div style="color:#666;font-size:0.85rem;">${tc.steps?.length || 0} steps</div>
        </label>
      </div>
    `;
  });
  
  listContainer.innerHTML = html;
}

function toggleTestCaseSelection(index) {
  const checkbox = document.getElementById(`tc-check-${index}`);
  if (!checkbox) return;
  
  if (checkbox.checked) {
    if (!selectedTestCaseIndices.includes(index)) {
      selectedTestCaseIndices.push(index);
    }
  } else {
    selectedTestCaseIndices = selectedTestCaseIndices.filter(i => i !== index);
  }
  
  addDebugLog(`Selected ${selectedTestCaseIndices.length} test case(s)`);
}

function toggleSelectAllTestCases() {
  const allCheckboxes = document.querySelectorAll('[id^="tc-check-"]');
  const allChecked = Array.from(allCheckboxes).every(cb => cb.checked);
  
  allCheckboxes.forEach((cb, idx) => {
    cb.checked = !allChecked;
    toggleTestCaseSelection(idx);
  });
  
  addDebugLog(`${!allChecked ? 'Selected' : 'Deselected'} all test cases`);
}

function renderPlanDropdown(statusEl) {
  if (availablePlans.length === 0) {
    addDebugLog('❌ No test plans found for this project');
    if (statusEl) {
      statusEl.textContent = '❌ No plans found in project';
      statusEl.style.color = '#dc2626';
    }
    return;
  }

  addDebugLog(`✅ Found ${availablePlans.length} test plans`);

  const planSelect = document.getElementById('plan-select');
  if (planSelect) {
    planSelect.innerHTML = '<option value="">-- Select a Plan --</option>';
    availablePlans.forEach(plan => {
      const opt = document.createElement('option');
      opt.value = plan.id;
      opt.textContent = `${plan.name}${plan.description ? ' - ' + plan.description.substring(0, 30) : ''}`;
      planSelect.appendChild(opt);
    });

    if (availablePlans.length > 0) {
      planSelect.value = availablePlans[0].id;
      selectedPlanId = availablePlans[0].id;
      addDebugLog(`📌 Auto-selected latest plan: ${availablePlans[0].name} (ID: ${availablePlans[0].id})`);
      setTimeout(() => {
        onPlanSelected();
      }, 300);
    }

    if (statusEl) {
      statusEl.textContent = `✅ Found ${availablePlans.length} plan(s)`;
      statusEl.style.color = '#16a34a';
    }
  }
}

function renderSuiteDropdown(statusEl) {
  const infoMsg = document.getElementById('suite-info-msg');
  if (availableSuites.length === 0) {
    if (infoMsg) {
      infoMsg.style.display = 'block';
      infoMsg.innerHTML = '<strong>ℹ️ No suites found.</strong> Plan may be empty or you may lack permissions.';
    }
    addDebugLog('ℹ️ No test suites found in plan');
  } else if (infoMsg) {
    infoMsg.style.display = 'none';
  }

  const selectBox = document.getElementById('suite-select');
  if (selectBox) {
    selectBox.innerHTML = '<option value="">-- Select Test Suite --</option>';
    availableSuites.forEach(suite => {
      const opt = document.createElement('option');
      opt.value = suite.id || suite.name;
      opt.textContent = suite.name + (suite.type ? ` [${suite.type}]` : '');
      selectBox.appendChild(opt);
    });
  }

  if (statusEl) {
    statusEl.style.display = 'block';
    if (availableSuites.length > 0) {
      statusEl.textContent = '✅ Fetch complete';
      statusEl.style.color = '#059669';
    } else {
      statusEl.textContent = '❌ No suites found';
      statusEl.style.color = '#dc2626';
    }
  }

  const suiteCount = document.getElementById('suite-count');
  if (suiteCount) {
    if (availableSuites.length > 0) {
      suiteCount.style.display = 'inline-block';
      suiteCount.textContent = `✅ ${availableSuites.length} suite(s)`;
    } else {
      suiteCount.style.display = 'none';
      suiteCount.textContent = '';
    }
  }
}

function setSuiteRefreshButtonState(isBusy = false, enabled = true) {
  const refreshBtn = document.getElementById('suite-refresh-btn');
  if (!refreshBtn) return;
  refreshBtn.disabled = isBusy || !enabled;
  refreshBtn.style.cursor = refreshBtn.disabled ? 'not-allowed' : 'pointer';
  refreshBtn.style.opacity = refreshBtn.disabled ? '0.6' : '1';
  refreshBtn.textContent = isBusy ? '⟳' : '↻';
}

function refreshSelectedPlanSuites(forceRefresh = true) {
  if (!selectedPlanId) {
    addDebugLog('⚠️ Please select a plan before refreshing suites');
    return;
  }
  fetchAvailableSuites({ forceRefresh, manual: true });
}

// Auto-fetch suites when test plan URL changes
function onTestPlanUrlChange() {
  const urlInput = document.getElementById('tfs-test-plan-url');
  const statusIcon = document.getElementById('suite-fetch-status');
  
  if (!urlInput || !urlInput.value.trim()) {
    if (statusIcon) {
      statusIcon.style.display = 'none';
    }
    // Clear plan and suite selections when URL is cleared
    selectedPlanId = null;
    availablePlans = [];
    availableSuites = [];
    selectedSuiteId = null;
    clearPlanSuiteCache();
    setSuiteRefreshButtonState(false, false);
    document.getElementById('plan-select').innerHTML = '<option value="">-- Select Plan --</option>';
    document.getElementById('suite-select').innerHTML = '<option value="">-- Select Suite --</option>';
    return;
  }
  
  // Debounce the fetch to avoid too many requests while typing
  if (window.testPlanUrlChangeTimeout) {
    clearTimeout(window.testPlanUrlChangeTimeout);
  }
  
  window.testPlanUrlChangeTimeout = setTimeout(() => {
    // Get TFS config from form inputs (don't wait for agent execution)
    const baseUrl = document.getElementById('tfs-base-url')?.value?.trim() || '';
    const username = document.getElementById('tfs-username')?.value?.trim() || '';
    const password = document.getElementById('tfs-password')?.value?.trim() || '';
    const patToken = document.getElementById('tfs-pat-token')?.value?.trim() || '';
    const testPlanUrl = urlInput.value.trim();
    
    // Only fetch if we have minimum required fields
    if (baseUrl && testPlanUrl && (username || patToken)) {
      // Build execution data with current form values
      const execData = {
        tfs_config: {
          base_url: baseUrl,
          username: username,
          password: password,
          pat_token: patToken,
          test_plan_url: testPlanUrl
        }
      };
      
      // Set it for use in fetch functions
      lastTestCaseExecutionData = execData;
      
      // Clear previous selections
      selectedPlanId = null;
      availablePlans = [];
      availableSuites = [];
      selectedSuiteId = null;
      
      // Fetch plans first (not suites directly)
      fetchAvailablePlans();
      if (statusIcon) {
        statusIcon.style.display = 'inline-block';
      }
      addDebugLog('📋 Auto-fetching test plans on URL change...');
    } else {
      addDebugLog('⚠️ Cannot auto-fetch: Missing base URL, username/PAT token, or test plan URL');
      if (statusIcon) {
        statusIcon.textContent = '⚠️ Fill config first';
        statusIcon.style.background = '#fef3c7';
        statusIcon.style.color = '#92400e';
        statusIcon.style.borderColor = '#fcd34d';
        statusIcon.style.display = 'inline-block';
      }
    }
  }, 800); // Wait 800ms after user stops typing before fetching
}

async function fetchAvailablePlans() {
  if (!lastTestCaseExecutionData || !lastTestCaseExecutionData.tfs_config) {
    addDebugLog('❌ TFS configuration not available');
    return;
  }
  if (isFetchingPlans) {
    addDebugLog('⏳ Plans fetch already in progress. Skipping duplicate request.');
    return;
  }

  const statusEl = document.getElementById('plan-status');
  if (statusEl) {
    statusEl.textContent = '⏳ Loading plans...';
    statusEl.style.color = '#0f172a';
  }

  isFetchingPlans = true;
  try {
    // Get test plan URL from config or input field (config takes priority)
    let testPlanUrl = lastTestCaseExecutionData.tfs_config.test_plan_url || '';
    
    // Fallback to input field if config doesn't have it
    if (!testPlanUrl) {
      const testPlanUrlEl = document.getElementById('tfs-test-plan-url');
      testPlanUrl = testPlanUrlEl?.value?.trim() || '';
    }
    
    if (!testPlanUrl) {
      throw new Error('Test Plan URL is required. Please enter it in the TFS configuration.');
    }

    addDebugLog(`📋 Parsing Test Plan URL to extract project: ${testPlanUrl}`);

    // Parse test plan URL to extract collection, project
    let collectionUrl = '';
    let project = '';

    try {
      const url = new URL(testPlanUrl);
      const protocol = url.protocol; // http: or https:
      const host = url.host;         // server:port
      const pathParts = url.pathname.split('/').filter(p => p); // split path into parts

      addDebugLog(`📋 URL Parts: [${pathParts.join(', ')}]`);

      // Modern Azure DevOps / TFS format: server:port/tfs/Collection/Project/_testManagement
      // Or: server:port/tfs/Collection/Project/_testPlans
      let tfsIndex = pathParts.findIndex(p => p.toLowerCase() === 'tfs');

      if (tfsIndex >= 0 && pathParts.length >= tfsIndex + 3) {
        // Standard /tfs/Collection/Project structure
        const collection = pathParts[tfsIndex + 1];
        project = pathParts[tfsIndex + 2];
        collectionUrl = `${protocol}//${host}/tfs/${collection}`;
      } else {
        // Fallback: look for markers like _testPlans or _testManagement
        let markers = ['_testplans', '_testmanagement', '_testrun'];
        let markerIndex = -1;
        for (let m of markers) {
           markerIndex = pathParts.findIndex(p => p.toLowerCase() === m);
           if (markerIndex >= 1) break;
        }

        if (markerIndex >= 1) {
          project = pathParts[markerIndex - 1];
          // Collection is everything before project
          if (tfsIndex >= 0 && markerIndex > tfsIndex + 1) {
              const collection = pathParts[tfsIndex + 1];
              collectionUrl = `${protocol}//${host}/tfs/${collection}`;
          } else {
              collectionUrl = `${protocol}//${host}/tfs`;
          }
        } else {
          // Last resort: assume project is the 3rd part or last part
          project = pathParts[2] || pathParts[pathParts.length - 1];
          collectionUrl = lastTestCaseExecutionData.tfs_config.base_url || `${protocol}//${host}/tfs`;
        }
      }

      addDebugLog(`✅ Extraction Result - Collection: ${collectionUrl}, Project: ${project}`);      
      // Store for later use in upload function
      extractedTfsCollectionUrl = collectionUrl;
      extractedTfsProject = project;
    } catch (e) {
      addDebugLog('⚠️ Could not parse test plan URL: ' + e.message);
      throw new Error(`Invalid Test Plan URL format: ${e.message}`);
    }

    if (!collectionUrl) {
      collectionUrl = lastTestCaseExecutionData.tfs_config.base_url || '';
    }
    
    if (!project) {
      throw new Error('Could not extract project from Test Plan URL');
    }

    const requestBody = {
      project: project,
      plan_id: null,  // Not needed for plans fetch
      tfs_config: {
        base_url: collectionUrl,
        username: lastTestCaseExecutionData.tfs_config.username || '',
        password: lastTestCaseExecutionData.tfs_config.password || '',
        pat_token: lastTestCaseExecutionData.tfs_config.pat_token || '',
        task_url: lastTestCaseExecutionData.tfs_config.task_url || '',
        test_plan_url: testPlanUrl
      }
    };

    const cacheKey = buildPlanCacheKey(collectionUrl, project, requestBody.tfs_config, testPlanUrl);
    const cachedPlans = readFreshCache(planCache, cacheKey, PLAN_CACHE_TTL_MS);
    if (cachedPlans) {
      availablePlans = cachedPlans;
      addDebugLog(`⚡ Loaded ${availablePlans.length} plan(s) from cache`);
      renderPlanDropdown(statusEl);
      return;
    }

    addDebugLog(`📤 Sending request to fetch plans with project="${project}", baseUrl="${collectionUrl}"`);

    const response = await fetchWithTimeout(`${API_BASE}/tfs/plans`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody)
    }, 60000);

    const data = await response.json();
    
    addDebugLog(`📥 Fetch plans response status: ${response.status}`);
    
    if (!response.ok || !data.success) {
      throw new Error(data.message || 'Failed to fetch plans');
    }

    availablePlans = data.plans || [];
    writeCache(planCache, cacheKey, availablePlans);
    renderPlanDropdown(statusEl);
    
  } catch (error) {
    // Handle AbortError (timeout)
    if (error.name === 'AbortError') {
      addDebugLog(`❌ Request timeout while fetching plans (exceeded 60 seconds)`);
      if (statusEl) {
        statusEl.textContent = `❌ Timed out while loading plans. Please wait a moment and try again.`;
        statusEl.style.color = '#dc2626';
      }
    } else {
      addDebugLog(`❌ Error fetching plans: ${error.message}`);
      if (statusEl) {
        statusEl.textContent = `❌ Error: ${error.message}`;
        statusEl.style.color = '#dc2626';
      }
    }
  } finally {
    isFetchingPlans = false;
  }
}

function onPlanSelected() {
  const planSelect = document.getElementById('plan-select');
  const suiteSection = document.getElementById('suite-section');
  const suiteSelect = document.getElementById('suite-select');
  const newSuiteName = document.getElementById('new-suite-name');
  const createBtn = document.querySelector('button[onclick="createNewSuite()"]');
  
  selectedPlanId = planSelect?.value || null;
  
  if (selectedPlanId) {
    const selectedPlan = availablePlans.find(p => p.id === selectedPlanId);
    addDebugLog(`📋 Plan selected: ${selectedPlan?.name || selectedPlanId}`);
    
    // Enable Step 2 section
    if (suiteSection) {
      suiteSection.style.opacity = '1';
      suiteSection.style.background = '#fffbeb';
      suiteSection.style.borderColor = '#fed7aa';
    }
    
    // Enable suite dropdown and create inputs
    if (suiteSelect) {
      suiteSelect.disabled = false;
      suiteSelect.style.cursor = 'auto';
      suiteSelect.style.background = 'white';
    }
    if (newSuiteName) {
      newSuiteName.disabled = false;
      newSuiteName.style.cursor = 'auto';
      newSuiteName.style.background = 'white';
    }
    if (createBtn) {
      createBtn.disabled = false;
      createBtn.style.cursor = 'pointer';
      createBtn.style.background = '#16a34a';
      createBtn.style.color = 'white';
    }

    setSuiteRefreshButtonState(false, true);
    const suiteStatus = document.getElementById('suite-status');
    if (suiteStatus) {
      suiteStatus.style.display = 'block';
      suiteStatus.style.color = '#0f172a';
      suiteStatus.textContent = '⏳ Loading suites in background...';
    }

    // Auto-fetch suites for this plan (background)
    setTimeout(() => {
      fetchAvailableSuites({ forceRefresh: false, manual: false });
    }, 0);
    
  } else {
    addDebugLog('📋 Cleared plan selection');
    
    // Disable Step 2 section
    if (suiteSection) {
      suiteSection.style.opacity = '0.6';
      suiteSection.style.background = '#f5f5f5';
      suiteSection.style.borderColor = '#d1d5db';
    }
    
    // Disable suite dropdown and create inputs
    if (suiteSelect) {
      suiteSelect.disabled = true;
      suiteSelect.style.cursor = 'not-allowed';
      suiteSelect.style.background = '#f9fafb';
      suiteSelect.innerHTML = '<option value="">-- Select Test Suite --</option>';
    }
    if (newSuiteName) {
      newSuiteName.disabled = true;
      newSuiteName.style.cursor = 'not-allowed';
      newSuiteName.style.background = '#f9fafb';
    }
    if (createBtn) {
      createBtn.disabled = true;
      createBtn.style.cursor = 'not-allowed';
      createBtn.style.background = '#d1d5db';
      createBtn.style.color = '#6b7280';
    }
    
    // Hide suite count
    const suiteCount = document.getElementById('suite-count');
    if (suiteCount) suiteCount.style.display = 'none';
    setSuiteRefreshButtonState(false, false);
    
    // Clear suites
    availableSuites = [];
    selectedSuiteId = null;
  }
}

function onSuiteSearchInput() {
  // Filter available suites based on search input
  const searchBox = document.getElementById('suite-search');
  const selectBox = document.getElementById('suite-select');
  
  if (!searchBox || !selectBox) return;
  
  const searchTerm = (searchBox.value || '').toLowerCase();
  const options = selectBox.querySelectorAll('option');
  
  options.forEach((opt) => {
    if (opt.value === '') return; // Skip placeholder
    const text = opt.textContent.toLowerCase();
    opt.style.display = text.includes(searchTerm) ? 'block' : 'none';
  });
}

async function fetchAvailableSuites(options = {}) {
  const forceRefresh = !!options.forceRefresh;
  const manual = !!options.manual;
  if (!lastTestCaseExecutionData || !lastTestCaseExecutionData.tfs_config) {
    addDebugLog('❌ TFS configuration not available');
    return;
  }
  if (isFetchingSuites) {
    addDebugLog('⏳ Suites fetch already in progress. Skipping duplicate request.');
    return;
  }

  if (!selectedPlanId) {
    addDebugLog('⚠️ Please select a test plan first');
    return;
  }

  const statusEl = document.getElementById('suite-status');
  if (statusEl) {
    statusEl.style.display = 'block';
    statusEl.textContent = manual ? '⏳ Refreshing suites...' : '⏳ Loading suites in background...';
    statusEl.style.color = '#0f172a';
  }

  isFetchingSuites = true;
  setSuiteRefreshButtonState(true, true);
  try {
    // Get test plan URL from input field
    const testPlanUrlEl = document.getElementById('tfs-test-plan-url');
    const testPlanUrl = testPlanUrlEl?.value?.trim() || '';
    
    if (!testPlanUrl) {
      throw new Error('Test Plan URL is required. Please enter it in the TFS configuration.');
    }

    addDebugLog(`📋 Fetching suites for plan ${selectedPlanId}: ${testPlanUrl}`);

    // Parse test plan URL to extract collection and project
    let collectionUrl = '';
    let project = '';
    
    try {
      const url = new URL(testPlanUrl);
      const protocol = url.protocol; // http: or https:
      const host = url.host;         // server:port
      const pathParts = url.pathname.split('/').filter(p => p); // split path into parts
      
      addDebugLog(`📋 URL breakdown - Protocol: ${protocol}, Host: ${host}, Path parts: [${pathParts.join(', ')}]`);
      
      // Look for 'tfs' in path
      let tfsIndex = pathParts.findIndex(p => p.toLowerCase() === 'tfs');
      let testPlansIndex = pathParts.findIndex(p => p.toLowerCase() === 'testplans');
      let testPlansUrlIndex = pathParts.findIndex(p => p.toLowerCase() === '_testplans');
      let testManagementIndex = pathParts.findIndex(p => p.toLowerCase() === '_testmanagement');
      
      addDebugLog(`📋 TFS index: ${tfsIndex}, TestPlans index: ${testPlansIndex}, _testPlans index: ${testPlansUrlIndex}, TestManagement index: ${testManagementIndex}`);
      
      if (testManagementIndex >= 1) {
        // Web UI format: /tfs/Collection/Project/_testManagement/...
        // Collection and Project are 2 positions before _testManagement
        if (tfsIndex >= 0 && testManagementIndex >= 2) {
          const collection = pathParts[tfsIndex + 1];
          project = pathParts[testManagementIndex - 1];
          collectionUrl = `${protocol}//${host}/tfs/${collection}`;
          
          addDebugLog(`📋 Detected Web UI format (_testManagement) - Collection: ${collection}, Project: ${project}`);
        }
      } else if (testPlansUrlIndex >= 1) {
        // Execute page format: /tfs/Collection/Project/_testPlans/execute?planId=52418
        if (tfsIndex >= 0 && testPlansUrlIndex >= 2) {
          const collection = pathParts[tfsIndex + 1];
          project = pathParts[testPlansUrlIndex - 1];
          collectionUrl = `${protocol}//${host}/tfs/${collection}`;
          
          addDebugLog(`📋 Detected Execute page format (_testPlans) - Collection: ${collection}, Project: ${project}, PlanId: ${selectedPlanId}`);
        }
      } else if (testPlansIndex >= 1) {
        // API format: /tfs/Collection/Project/TestPlans/[planId]
        project = pathParts[testPlansIndex - 1]; // Project is right before TestPlans
        
        // Try to build collection URL
        if (tfsIndex >= 0) {
          // /tfs/Collection format
          const collection = pathParts[tfsIndex + 1];
          collectionUrl = `${protocol}//${host}/tfs/${collection}`;
        } else if (testPlansIndex >= 2) {
          // /Collection/Project/TestPlans format
          const collection = pathParts[testPlansIndex - 2];
          collectionUrl = `${protocol}//${host}/tfs/${collection}`;
        } else {
          // Just /Project/TestPlans format - use full host
          collectionUrl = `${protocol}//${host}/tfs`;
        }
        
        addDebugLog(`📋 Detected API format - Project: ${project}, PlanId: ${selectedPlanId}`);
      } else {
        // Fallback: try to use base_url from config and last parts as collection/project
        collectionUrl = lastTestCaseExecutionData.tfs_config.base_url || testPlanUrl;
        
        // Try to find collection and project from path
        if (tfsIndex >= 0 && pathParts.length > tfsIndex + 2) {
          const collection = pathParts[tfsIndex + 1];
          project = pathParts[tfsIndex + 2];
          collectionUrl = `${protocol}//${host}/tfs/${collection}`;
          addDebugLog(`📋 Fallback extraction - Collection: ${collection}, Project: ${project}`);
        } else {
          project = pathParts[pathParts.length - 1]; // Use last part as project
          addDebugLog(`📋 Fallback: Using last path part as project`);
        }
      }
      
      addDebugLog(`📋 Final extraction - Collection: ${collectionUrl}, Project: ${project}, PlanId: ${selectedPlanId}`);
    } catch (e) {
      addDebugLog('⚠️ Could not parse test plan URL: ' + e.message);
      throw new Error(`Invalid Test Plan URL format: ${e.message}`);
    }

    if (!collectionUrl) {
      collectionUrl = lastTestCaseExecutionData.tfs_config.base_url || '';
    }
    
    if (!project) {
      throw new Error('Could not extract project from Test Plan URL');
    }

    const requestBody = {
      project: project,
      plan_id: selectedPlanId,
      tfs_config: {
        base_url: collectionUrl,
        username: lastTestCaseExecutionData.tfs_config.username || '',
        password: lastTestCaseExecutionData.tfs_config.password || '',
        pat_token: lastTestCaseExecutionData.tfs_config.pat_token || '',
        task_url: lastTestCaseExecutionData.tfs_config.task_url || '',
        test_plan_url: testPlanUrl
      }
    };

    const cacheKey = buildSuiteCacheKey(collectionUrl, project, selectedPlanId, requestBody.tfs_config, testPlanUrl);
    const cachedSuites = forceRefresh ? null : readFreshCache(suiteCache, cacheKey, SUITE_CACHE_TTL_MS);
    if (cachedSuites) {
      availableSuites = cachedSuites;
      addDebugLog(`⚡ Loaded ${availableSuites.length} suite(s) from cache`);
      renderSuiteDropdown(statusEl);
      return;
    }

    addDebugLog(`📤 Sending request to fetch suites with project="${project}", planId="${selectedPlanId}", baseUrl="${collectionUrl}"`);

    const response = await fetchWithTimeout(`${API_BASE}/tfs/suites`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody)
    }, 30000);

    const data = await response.json();
    
    addDebugLog(`📥 Response status: ${response.status}, Data: ${JSON.stringify(data)}`);
    
    if (!response.ok || !data.success) {
      throw new Error(data.message || 'Failed to fetch suites');
    }

    availableSuites = data.suites || [];
    writeCache(suiteCache, cacheKey, availableSuites);
    renderSuiteDropdown(statusEl);

    addDebugLog(`✅ Fetched ${availableSuites.length} available suites`);
  } catch (error) {
    console.error('Suite fetch error:', error);
    
    // Handle AbortError (timeout)
    let errorMsg = error.message;
    if (error.name === 'AbortError') {
      errorMsg = 'Timed out while loading suites. Please wait a moment and try again.';
    }
    
    if (statusEl) {
      statusEl.style.display = 'block';
      statusEl.style.color = '#dc2626';
      statusEl.textContent = `❌ Error: ${errorMsg}`;
    }
    
    // Show detailed error message
    const infoMsg = document.getElementById('suite-info-msg');
    if (infoMsg) {
      infoMsg.style.display = 'block';
      infoMsg.innerHTML = `
        <strong>❌ Error loading suites</strong>
        <ul style="margin:4px 0 0 20px;padding:0;color:#dc2626;">
          <li>${errorMsg}</li>
          <li>Try selecting a different plan</li>
          <li>Check TFS credentials and configuration</li>
        </ul>
      `;
    }
    
    addDebugLog(`❌ Error fetching suites: ${errorMsg}`);
  } finally {
    isFetchingSuites = false;
    setSuiteRefreshButtonState(false, !!selectedPlanId);
  }
}

function onSuiteSelected() {
  const selectBox = document.getElementById('suite-select');
  const newSuiteInput = document.getElementById('new-suite-name');
  
  if (selectBox && selectBox.value) {
    selectedSuiteId = selectBox.value;
    newSuiteName = null;
    if (newSuiteInput) newSuiteInput.value = '';
    addDebugLog(`Selected suite: ${selectBox.options[selectBox.selectedIndex].text}`);
  }
}

function clearSuiteSelection() {
  const selectBox = document.getElementById('suite-select');
  if (selectBox) selectBox.value = '';
  selectedSuiteId = null;
}

async function createNewSuite() {
  const newSuiteInput = document.getElementById('new-suite-name');
  const suiteName = (newSuiteInput?.value || '').trim();
  
  if (!suiteName) {
    addDebugLog('❌ Please enter a suite name');
    return;
  }

  if (!lastTestCaseExecutionData || !lastTestCaseExecutionData.tfs_config) {
    addDebugLog('❌ TFS configuration not available');
    return;
  }

  const statusEl = document.getElementById('suite-status');
  if (statusEl) {
    statusEl.style.display = 'block';
    statusEl.textContent = '⏳ Creating suite...';
    statusEl.style.color = '#0f172a';
  }

  try {
    // Extract project name from base URL
    let project = '';
    const baseUrl = lastTestCaseExecutionData.tfs_config.base_url || '';
    if (baseUrl) {
      // Format: http://server:port/tfs/Collection/Project
      const parts = baseUrl.split('/').filter(p => p);
      if (parts.length >= 3) {
        project = parts[parts.length - 1]; // Get the project name (last part)
      }
    }

    const response = await fetchWithTimeout(`${API_BASE}/tfs/create-suite`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        suite_name: suiteName,
        project: project,
        plan_id: lastTestCaseExecutionData.tfs_config.plan_id || null,
        tfs_config: {
          base_url: baseUrl,
          username: lastTestCaseExecutionData.tfs_config.username || '',
          password: lastTestCaseExecutionData.tfs_config.password || '',
          pat_token: lastTestCaseExecutionData.tfs_config.pat_token || ''
        }
      })
    }, 30000);

    const data = await response.json();
    
    if (!response.ok || !data.success) {
      throw new Error(data.message || 'Failed to create suite');
    }

    selectedSuiteId = data.suite_id;
    newSuiteName = suiteName;
    
    // Update dropdown
    const selectBox = document.getElementById('suite-select');
    if (selectBox) {
      selectBox.value = selectedSuiteId;
      // Also add to list for future reference
      const opt = document.createElement('option');
      opt.value = selectedSuiteId;
      opt.textContent = suiteName + ' [NEW]';
      opt.selected = true;
      selectBox.appendChild(opt);
    }

    if (statusEl) {
      statusEl.style.display = 'block';
      statusEl.textContent = `✅ Suite "${suiteName}" created successfully`;
      statusEl.style.color = '#059669';
    }

    addDebugLog(`✅ Created new suite: ${suiteName}`);
  } catch (error) {
    if (statusEl) {
      statusEl.style.display = 'block';
      statusEl.textContent = `❌ Error: ${error.message}`;
      statusEl.style.color = '#dc2626';
    }
    addDebugLog(`❌ Failed to create suite: ${error.message}`);
  }
}

async function uploadTestCasesToSuite() {
  // Validate selections
  if (!selectedTestCaseIndices || selectedTestCaseIndices.length === 0) {
    addDebugLog('❌ Please select at least one test case');
    return;
  }

  if (!selectedSuiteId && !newSuiteName) {
    addDebugLog('❌ Please select or create a suite');
    return;
  }

  // Collect selected test cases
  const testsToUpload = selectedTestCaseIndices.map(idx => parsedTestCases[idx]);
  
  const statusEl = document.getElementById('suite-status');
  if (statusEl) {
    statusEl.style.display = 'block';
    statusEl.textContent = `⏳ Uploading ${testsToUpload.length} test case(s)...`;
    statusEl.style.color = '#0f172a';
  }

  try {
    // Use extracted project and collection URL from test plan parsing
    let project = extractedTfsProject || '';
    let baseUrl = extractedTfsCollectionUrl || (lastTestCaseExecutionData?.tfs_config?.base_url || '');
    
    if (!project) {
      addDebugLog('❌ Project information not available. Please select a test plan first.');
      if (statusEl) {
        statusEl.style.display = 'block';
        statusEl.textContent = `❌ Project info missing - select plan first`;
        statusEl.style.color = '#dc2626';
      }
      return;
    }

    const response = await fetchWithTimeout(`${API_BASE}/tfs/upload-test-cases`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        test_cases: testsToUpload,
        suite_id: selectedSuiteId,
        work_item_id: lastTestCaseExecutionData?.work_item_id || 0,
        project: project,
        plan_id: selectedPlanId || null,
        tfs_config: {
          base_url: baseUrl,
          username: lastTestCaseExecutionData?.tfs_config?.username || '',
          password: lastTestCaseExecutionData?.tfs_config?.password || '',
          pat_token: lastTestCaseExecutionData?.tfs_config?.pat_token || ''
        }
      })
    }, 30000);

    const data = await response.json();
    
    if (!response.ok || !data.success) {
      throw new Error(data.message || 'Failed to upload test cases');
    }

    if (statusEl) {
      statusEl.style.display = 'block';
      statusEl.textContent = `✅ Uploaded ${data.uploaded || testsToUpload.length} test case(s) successfully!`;
      statusEl.style.color = '#059669';
    }

    addDebugLog(`✅ Uploaded ${data.uploaded || testsToUpload.length} test cases to suite "${newSuiteName || selectedSuiteId}"`);
    
    // Reset selection
    setTimeout(() => {
      cancelTestCaseUpload();
    }, 2000);
  } catch (error) {
    if (statusEl) {
      statusEl.style.display = 'block';
      statusEl.textContent = `❌ Error: ${error.message}`;
      statusEl.style.color = '#dc2626';
    }
    addDebugLog(`❌ Failed to upload test cases: ${error.message}`);
  }
}

function cancelTestCaseUpload() {
  // Reset states
  selectedTestCaseIndices = [];
  selectedSuiteId = null;
  newSuiteName = null;
  
  // Hide upload section and show chat section
  const uploadSection = document.getElementById('testcase-upload-section');
  const chatSection = document.getElementById('testcase-analysis-chat-section');
  
  if (uploadSection) uploadSection.style.display = 'none';
  if (chatSection) chatSection.style.display = 'block';
  
  addDebugLog('↩️ Upload cancelled, returned to analysis chat');
}

// ==================== Test Case Chat & Review ====================

let testCaseChatHistory = [];
let lastReviewText = ""; // Store review text for generating missing cases

function clearTestCaseChat() {
  const container = document.getElementById('testcase-chat-container');
  if (container) {
    container.innerHTML = `
      <div style="text-align:center;color:#64748b;font-size:0.9rem;padding:20px;">
        <div>💭 Start by asking questions about your test cases</div>
        <div style="font-size:0.85rem;margin-top:8px;">Click "Review Test Cases" for AI analysis or type your own question</div>
      </div>
    `;
  }
  testCaseChatHistory = [];
  addDebugLog('🧹 Test case chat cleared');
}

function clearChatInput() {
  const inputEl = document.getElementById('testcase-chat-input');
  if (inputEl) {
    inputEl.value = '';
    inputEl.focus();
  }
}

function handleChatInputKeydown(event) {
  // Send on Enter (without Shift)
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    sendTestCaseQuestion();
  }
  // Allow Shift+Enter for new line
}

function buildTestCaseMarkdown(testCases) {
  /**
   * Convert parsed test cases array back to markdown table format
   */
  if (!testCases || testCases.length === 0) {
    return '| Title | Step Action | Step Expected |\n| --- | --- | --- |';
  }

  let markdown = '| Title | Step Action | Step Expected |\n';
  markdown += '| --- | --- | --- |\n';

  for (const tc of testCases) {
    // Add title row
    markdown += `| ${tc.title} | | |\n`;
    
    // Add step rows
    if (tc.steps && tc.steps.length > 0) {
      for (const step of tc.steps) {
        markdown += `| | ${step.action} | ${step.expected} |\n`;
      }
    }
  }

  return markdown;
}

function addChatMessage(role, message, isMarkdown = false) {
  const container = document.getElementById('testcase-chat-container');
  if (!container) return;

  // Clear empty state if exists
  if (container.innerHTML.includes('Start by asking questions')) {
    container.innerHTML = '';
  }

  // Create message element
  const messageDiv = document.createElement('div');
  messageDiv.style.cssText = `
    display: flex;
    margin-bottom: 12px;
    gap: 8px;
    animation: slideIn 0.3s ease-in;
  `;

  const isUser = role === 'user';
  const bgColor = isUser ? '#e0f2fe' : '#f0fdf4';
  const textColor = isUser ? '#0c4a6e' : '#15803d';
  const borderColor = isUser ? '#0ea5e9' : '#86efac';

  const contentDiv = document.createElement('div');
  contentDiv.style.cssText = `
    flex: 1;
    padding: 10px 12px;
    background: ${bgColor};
    border-left: 3px solid ${borderColor};
    border-radius: 6px;
    color: ${textColor};
    font-size: 0.9rem;
    line-height: 1.5;
    word-wrap: break-word;
  `;

  if (isMarkdown) {
    // Simple markdown to HTML conversion
    let html = message
      .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.*?)\*/g, '<em>$1</em>')
      .replace(/`(.*?)`/g, '<code style="background:#fff;padding:2px 4px;border-radius:3px;font-family:monospace;">$1</code>')
      .replace(/\n/g, '<br>');
    contentDiv.innerHTML = html;
  } else {
    contentDiv.textContent = message;
  }

  messageDiv.appendChild(contentDiv);
  container.appendChild(messageDiv);

  // Check if this is an assistant message with grid format test cases
  if (role === 'assistant' && isMarkdown && detectGridFormatTestCases(message)) {
    // Add merge button
    const buttonDiv = document.createElement('div');
    buttonDiv.style.cssText = `
      display: flex;
      justify-content: center;
      margin: 8px 0;
      gap: 8px;
    `;

    const mergeBtn = document.createElement('button');
    mergeBtn.textContent = '✓ Merge into Current Test Cases';
    mergeBtn.style.cssText = `
      padding: 8px 14px;
      background: #059669;
      color: white;
      border: none;
      border-radius: 6px;
      cursor: pointer;
      font-size: 0.85rem;
      font-weight: 600;
      transition: all 0.2s;
    `;
    
    mergeBtn.onclick = () => mergeGeneratedTestCases(message);
    
    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = '✕ Discard';
    cancelBtn.style.cssText = `
      padding: 8px 14px;
      background: #ef4444;
      color: white;
      border: none;
      border-radius: 6px;
      cursor: pointer;
      font-size: 0.85rem;
      font-weight: 600;
      transition: all 0.2s;
    `;
    cancelBtn.onclick = () => buttonDiv.remove();
    
    buttonDiv.appendChild(mergeBtn);
    buttonDiv.appendChild(cancelBtn);
    container.appendChild(messageDiv);
    container.appendChild(buttonDiv);
  }

  container.scrollTop = container.scrollHeight;
}

function detectGridFormatTestCases(text) {
  /**
   * Detect if text contains grid format test cases
   * Grid format has multiple pipe characters and row structure
   */
  if (!text) return false;
  const gridIndicators = ['| Title |', '| Step Action |', '| Step Expected |', '|---|'];
  const hasMultiplePipes = (text.match(/\|/g) || []).length > 10;
  const hasGridPatterns = gridIndicators.some(indicator => text.includes(indicator));
  return hasMultiplePipes && hasGridPatterns;
}

function mergeGridFormatTestCases(gridText) {
  /**
   * Parse grid format test cases and merge into current test cases
   */
  if (!gridText) {
    addDebugLog('❌ No test cases to merge');
    return;
  }

  try {
    const newTestCases = parseTestCasesFromMarkdown(gridText);
    if (newTestCases.length > 0) {
      const previousCount = parsedTestCases.length;
      parsedTestCases = [...parsedTestCases, ...newTestCases];
      addDebugLog(`✅ Merged ${newTestCases.length} test cases`);
      
      // Update Output tab with scrollable HTML format
      const combinedMarkdown = buildTestCaseMarkdown(parsedTestCases);
      const outputContent = document.getElementById('output-content');
      if (outputContent) {
        outputContent.setAttribute('data-format', 'html');
        outputContent.innerHTML = generateTestCaseHTMLTableScrollable(parsedTestCases);
        addDebugLog('📄 Output tab updated after merge');
      }
      
      // Update lastTestCaseResult for export
      if (lastTestCaseResult) {
        lastTestCaseResult.result = combinedMarkdown;
        addDebugLog('💾 Export data updated after merge');
      }
      
      // Update count display
      const testCaseCountEl = document.getElementById('testcase-count');
      if (testCaseCountEl) {
        testCaseCountEl.textContent = parsedTestCases.length;
      }
      
      // Show confirmation
      showToast(`✅ Merged ${newTestCases.length} test cases successfully`);
      addChatMessage('assistant', 
        `✅ **Merged successfully!**\n\n**${newTestCases.length} test cases added**\n\nTotal: **${parsedTestCases.length}** (${previousCount} + ${newTestCases.length})\n\n✅ Output tab updated\n✅ All cases ready for upload`, 
        true);
    } else {
      addDebugLog('⚠️ No test cases found in grid format');
    }
  } catch (error) {
    addDebugLog(`❌ Merge failed: ${error.message}`);
  }
}

async function sendTestCaseQuestion() {
  const inputEl = document.getElementById('testcase-chat-input');
  const question = (inputEl?.value || '').trim();

  if (!question) {
    addDebugLog('❌ Please enter a question');
    return;
  }

  if (!lastTestCaseResult) {
    addDebugLog('❌ No test cases to analyze');
    return;
  }

  // Add user message to chat
  addChatMessage('user', question);
  testCaseChatHistory.push({ role: 'user', content: question });
  inputEl.value = '';

  // Show loading state
  addChatMessage('assistant', '🔄 Analyzing test cases...');
  addDebugLog(`📤 Sending question: "${question.substring(0, 50)}..."`);

  try {
    const testCases = String(lastTestCaseResult.result || '');
    const storyDetails = lastTestCaseExecutionData?.story_details || '';
    
    const response = await fetchWithTimeout(`${API_BASE}/agent/analyze-test-cases`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        test_cases: testCases,
        story_details: storyDetails,
        question: question,
        chat_history: testCaseChatHistory.slice(0, -1),
        llm_config: lastTestCaseExecutionData?.llm_config || null
      })
    }, 60000);

    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      throw new Error(errData.error || errData.detail || `HTTP ${response.status}`);
    }

    const data = await response.json();
    
    // Check response status
    if (data.status === 'error') {
      throw new Error(data.error || 'Analysis failed');
    }
    
    const aiResponse = data.response || data.analysis || 'Analysis completed';

    // Remove loading message
    const container = document.getElementById('testcase-chat-container');
    if (container && container.lastChild) {
      container.removeChild(container.lastChild);
    }

    // Add AI response
    addChatMessage('assistant', aiResponse, true);
    testCaseChatHistory.push({ role: 'assistant', content: aiResponse });
    addDebugLog('✅ Analysis complete');

  } catch (error) {
    // Remove loading message
    const container = document.getElementById('testcase-chat-container');
    if (container && container.lastChild) {
      container.removeChild(container.lastChild);
    }

    const errMsg = `❌ Analysis failed: ${error.message}`;
    addChatMessage('assistant', errMsg);
    addDebugLog(errMsg);
  }
}

async function reviewTestCases() {
  if (!lastTestCaseResult) {
    addDebugLog('❌ No test cases to review');
    return;
  }

  // Add message indicating review is starting
  addChatMessage('assistant', '🔍 Starting comprehensive test case review...');
  addDebugLog('🔍 Launching test case review agent');

  try {
    const testCases = String(lastTestCaseResult.result || '');
    const storyDetails = lastTestCaseExecutionData?.story_details || '';

    const response = await fetchWithTimeout(`${API_BASE}/agent/review-test-cases`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        test_cases: testCases,
        story_details: storyDetails,
        llm_config: lastTestCaseExecutionData?.llm_config || null
      })
    }, 90000); // Longer timeout for review

    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      throw new Error(errData.error || errData.detail || `HTTP ${response.status}`);
    }

    const data = await response.json();
    
    // Check response status
    if (data.status === 'error') {
      throw new Error(data.error || 'Review failed');
    }
    
    const reviewOutput = data.review || data.analysis || 'Review completed';

    // Remove loading message
    const container = document.getElementById('testcase-chat-container');
    if (container && container.lastChild) {
      container.removeChild(container.lastChild);
    }

    // Add review output
    addChatMessage('assistant', reviewOutput, true);
    lastReviewText = reviewOutput; // Store for generating missing cases
    testCaseChatHistory.push({ 
      role: 'assistant', 
      content: `[AUTO REVIEW]\n${reviewOutput}` 
    });
    
    // Show button to generate missing cases if review mentions missing/gaps
    if (reviewOutput.toLowerCase().includes('missing') || 
        reviewOutput.toLowerCase().includes('gap') || 
        reviewOutput.toLowerCase().includes('lack')) {
      addGenerateMissingCasesButton();
    }
    
    addDebugLog('✅ Test case review completed');

  } catch (error) {
    // Remove loading message
    const container = document.getElementById('testcase-chat-container');
    if (container && container.lastChild) {
      container.removeChild(container.lastChild);
    }

    const errMsg = `❌ Review failed: ${error.message}`;
    addChatMessage('assistant', errMsg);
    addDebugLog(errMsg);
  }
}

function addGenerateMissingCasesButton() {
  const container = document.getElementById('testcase-chat-container');
  if (!container) return;

  // Create button container
  const buttonDiv = document.createElement('div');
  buttonDiv.style.cssText = `
    display: flex;
    justify-content: center;
    margin: 12px 0;
    gap: 8px;
  `;

  const btn = document.createElement('button');
  btn.textContent = '✨ Generate Missing Test Cases';
  btn.style.cssText = `
    padding: 10px 16px;
    background: #8b5cf6;
    color: white;
    border: none;
    border-radius: 6px;
    cursor: pointer;
    font-size: 0.9rem;
    font-weight: 600;
    transition: all 0.2s;
  `;
  btn.onmouseover = () => btn.style.background = '#7c3aed';
  btn.onmouseout = () => btn.style.background = '#8b5cf6';
  btn.onclick = generateMissingTestCases;

  buttonDiv.appendChild(btn);
  container.appendChild(buttonDiv);
}

async function generateMissingTestCases() {
  if (!lastReviewText) {
    addDebugLog('❌ No review data available');
    return;
  }

  const storyDetails = lastTestCaseExecutionData?.story_details || '';
  
  // Add loading message
  addChatMessage('assistant', '✨ Generating missing test cases...');
  addDebugLog('✨ Starting missing test case generation');

  try {
    const response = await fetchWithTimeout(`${API_BASE}/agent/generate-missing-testcases`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        story_details: storyDetails,
        review_text: lastReviewText,
        llm_config: lastTestCaseExecutionData?.llm_config || null
      })
    }, 90000);

    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      throw new Error(errData.error || errData.detail || `HTTP ${response.status}`);
    }

    const data = await response.json();
    
    if (data.status === 'error') {
      throw new Error(data.error || 'Generation failed');
    }

    const missingCases = data.missing_cases || 'No new test cases generated';

    // Remove loading message
    const container = document.getElementById('testcase-chat-container');
    if (container && container.lastChild) {
      container.removeChild(container.lastChild);
    }

    // Show generated missing cases
    addChatMessage('assistant', `**📋 Generated Missing Test Cases:**\n\n${missingCases}`, true);
    addDebugLog(`✅ Generated ${missingCases.split('|').length / 3} test cases`);

    // Parse and add missing cases to existing test cases
    const newTestCases = parseTestCasesFromMarkdown(missingCases);
    if (newTestCases.length > 0) {
      const previousCount = parsedTestCases.length;
      parsedTestCases = [...parsedTestCases, ...newTestCases];
      addDebugLog(`✅ Added ${newTestCases.length} missing test cases to list`);
      
      // Update Output tab with combined test cases (scrollable HTML format)
      const combinedMarkdown = buildTestCaseMarkdown(parsedTestCases);
      const outputContent = document.getElementById('output-content');
      if (outputContent) {
        outputContent.setAttribute('data-format', 'html');
        outputContent.innerHTML = generateTestCaseHTMLTableScrollable(parsedTestCases);
        addDebugLog('📄 Output tab updated with all test cases');
      }
      
      // Update testCaseCount display
      const testCaseCountEl = document.getElementById('testcase-count');
      if (testCaseCountEl) {
        testCaseCountEl.textContent = parsedTestCases.length;
      }
      
      // Update lastTestCaseResult so export works
      if (lastTestCaseResult) {
        lastTestCaseResult.result = combinedMarkdown;
        addDebugLog('💾 Export data updated with all test cases');
      }
      
      // Show summary
      addChatMessage('assistant', 
        `✅ **${newTestCases.length} new test cases added!**\n\nTotal test cases now: **${parsedTestCases.length}** (${previousCount} + ${newTestCases.length})\n\n✅ Output tab updated with all cases\n✅ Export will include all cases\n\nClick "📤 Upload to Suite" to save all test cases together.`, 
        true);
    }

  } catch (error) {
    // Remove loading message
    const container = document.getElementById('testcase-chat-container');
    if (container && container.lastChild) {
      container.removeChild(container.lastChild);
    }

    const errMsg = `❌ Generation failed: ${error.message}`;
    addChatMessage('assistant', errMsg);
    addDebugLog(errMsg);
  }
}

console.log('✅ All functions loaded');
addDebugLog('✅ TFS Agent Hub initialized');

// ==================== Agent 3: Bug, Feature & User Story Agent Logic ====================

let bugAgentState = {
    wiType: 'Bug',
    updateMode: false,
    currentScreenshots: [],
    formScreenshots: [],
    history: [],
    states: {
        'Bug': { workItemId: '', title: '', description: '', formScreenshots: [], history: [], chatHTML: '' },
        'Feature': { workItemId: '', title: '', description: '', formScreenshots: [], history: [], chatHTML: '' },
        'User Story': { workItemId: '', title: '', description: '', formScreenshots: [], history: [], chatHTML: '' }
    },
    dropdowns: {
        area: [],
        iteration: [],
        members: [],
        stories: []
    }
};

async function initBugAgentState() {
    addDebugLog('🔄 Initializing Bug, Feature & User Story Agent state...');
    bugAgentState.wiType = 'Bug';
    bugAgentState.updateMode = false;
    bugAgentState.currentScreenshots = [];
    bugAgentState.formScreenshots = [];
    bugAgentState.history = [];
    bugAgentState.states = {
        'Bug': { title: '', description: '', formScreenshots: [], history: [], chatHTML: '' },
        'Feature': { title: '', description: '', formScreenshots: [], history: [], chatHTML: '' }
    };
    
    // Set active class on radio toggles manually just in case
    const bugOpt = document.getElementById('opt-bug');
    const featOpt = document.getElementById('opt-feature');
    if (bugOpt) bugOpt.classList.add('active');
    if (featOpt) featOpt.classList.remove('active');

    // Add Enter key listener and Paste listener to chat input
    const chatInput = document.getElementById('bug-chat-input');
    if (chatInput) {
        chatInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                sendChatMessage();
            }
        });

        // Paste listener for images
        chatInput.addEventListener('paste', (e) => {
            const items = (e.clipboardData || e.originalEvent.clipboardData).items;
            for (let i = 0; i < items.length; i++) {
                if (items[i].type.indexOf('image') !== -1) {
                    const blob = items[i].getAsFile();
                    const reader = new FileReader();
                    reader.onload = function(event) {
                        const filename = `pasted_image_${new Date().getTime()}.png`;
                        bugAgentState.currentScreenshots.push({
                            name: filename,
                            data: event.target.result
                        });
                        renderScreenshotPreviews();
                    };
                    reader.readAsDataURL(blob);
                }
            }
        });
    }

    // Auto-fetch data for dropdowns
    const tfs = getEffectiveTFSConfig();
    if (tfs && tfs.base_url) {
        // Fetch and auto-select latest
        await Promise.all([
            fetchDropdownData('area', '/tfs/areas').then(() => {
                const areaInput = document.getElementById('wi-area');
                if (areaInput && bugAgentState.dropdowns.area.length > 0) {
                    const latest = bugAgentState.dropdowns.area[0].path || bugAgentState.dropdowns.area[0];
                    areaInput.value = latest;
                    addDebugLog(`📌 Default Area: ${latest}`);
                }
            }),
            fetchDropdownData('iteration', '/tfs/iterations').then(() => {
                const iterInput = document.getElementById('wi-iteration');
                if (iterInput && bugAgentState.dropdowns.iteration.length > 0) {
                    // Try to find current, otherwise first
                    const latest = bugAgentState.dropdowns.iteration.find(i => i.time_frame === 'current')?.path || bugAgentState.dropdowns.iteration[0].path || bugAgentState.dropdowns.iteration[0];
                    iterInput.value = latest;
                    addDebugLog(`📌 Default Iteration: ${latest}`);
                }
            }),
            fetchDropdownData('members', '/tfs/team-members'),
            fetchDropdownData('stories', '/tfs/work-items')
        ]);
    }
}

async function fetchDropdownData(type, endpoint) {
    try {
        const tfs = getEffectiveTFSConfig();
        if (!tfs.base_url) return;
        
        // SPEED OPTIMIZATION: Check client-side cache first
        const cacheKey = `cache_${type}_${tfs.base_url}`;
        const cached = sessionStorage.getItem(cacheKey);
        if (cached) {
            const data = JSON.parse(cached);
            if (type === 'area') bugAgentState.dropdowns.area = data;
            if (type === 'iteration') bugAgentState.dropdowns.iteration = data;
            if (type === 'members') bugAgentState.dropdowns.members = data;
            if (type === 'stories') bugAgentState.dropdowns.stories = data;
            console.log(`⚡ Using cached ${type} data`);
            return;
        }

        const response = await fetch(API_BASE + endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(type === 'members' ? { search_query: '', tfs_config: tfs } : tfs)
        });
        const data = await response.json();
        if (data.success) {
            let list = [];
            if (type === 'area') list = data.areas || [];
            if (type === 'iteration') list = data.iterations || [];
            if (type === 'members') list = data.members || [];
            if (type === 'stories') list = data.work_items || [];

            if (type === 'area') bugAgentState.dropdowns.area = list;
            if (type === 'iteration') bugAgentState.dropdowns.iteration = list;
            if (type === 'members') bugAgentState.dropdowns.members = list;
            if (type === 'stories') bugAgentState.dropdowns.stories = list;

            // Save to cache (valid for current session)
            sessionStorage.setItem(cacheKey, JSON.stringify(list));
            addDebugLog(`✅ Loaded ${type} dropdown data`);
        } else {
            console.warn(`⚠️ Failed to load ${type} data:`, data.error || 'Unknown error');
            addDebugLog(`⚠️ Failed to load ${type} data: ${data.error || 'Unknown error'}`);
        }
    } catch (e) {
        console.error(`❌ Error fetching ${type} data:`, e.message);
        addDebugLog(`⚠️ Failed to fetch ${type} data: ${e.message}`);
    }
}

function selectWIType(type) {
    const previousType = bugAgentState.wiType;
    if (previousType === type) return;

    // --- SAVE CURRENT STATE ---
    const titleEl = document.getElementById('wi-title');
    const descEl = document.getElementById('wi-description');
    const messages = document.getElementById('bug-chat-messages');
    const workItemIdEl = document.getElementById('update-work-item-id');

    if (!bugAgentState.states) bugAgentState.states = {};
    
    bugAgentState.states[previousType] = {
        workItemId: workItemIdEl ? workItemIdEl.value : '',
        title: titleEl ? titleEl.value : '',
        description: descEl ? descEl.value : '',
        formScreenshots: [...bugAgentState.formScreenshots],
        history: [...bugAgentState.history],
        chatHTML: messages ? messages.innerHTML : ''
    };

    // --- SWITCH TYPE ---
    bugAgentState.wiType = type;
    
    // --- RESTORE NEW STATE ---
    const newState = bugAgentState.states[type] || { workItemId: '', title: '', description: '', formScreenshots: [], history: [], chatHTML: '' };
    
    if (workItemIdEl) workItemIdEl.value = newState.workItemId || '';
    if (titleEl) titleEl.value = newState.title || '';
    if (descEl) descEl.value = newState.description || '';
    
    bugAgentState.formScreenshots = [...(newState.formScreenshots || [])];
    bugAgentState.history = [...(newState.history || [])];

    if (messages) {
        if (newState.chatHTML) {
            messages.innerHTML = newState.chatHTML;
        } else {
            // Initial greeting if no history
            let greeting = `Hello! Describe a bug, and I'll structure it for TFS. Screenshots are supported!`;
            if (type === 'Feature') greeting = `Hello! Describe a new feature, and I'll structure it for TFS.`;
            else if (type === 'User Story') greeting = `Hello! Describe a user story or requirement, and I'll structure it for TFS.`;
            
            messages.innerHTML = `
                <div class="chat-bubble ai">
                  ${greeting}
                </div>
            `;
        }
        messages.scrollTop = messages.scrollHeight;
    }

    const bugOpt = document.getElementById('opt-bug');
    const featOpt = document.getElementById('opt-feature');
    const storyOpt = document.getElementById('opt-story');
    if (bugOpt) bugOpt.classList.toggle('active', type === 'Bug');
    if (featOpt) featOpt.classList.toggle('active', type === 'Feature');
    if (storyOpt) storyOpt.classList.toggle('active', type === 'User Story');
    
    // Update labels and visibility
    const lbl = document.getElementById('lbl-description');
    const area = document.getElementById('wi-description');
    const rowBugTriage = document.getElementById('row-bug-triage');
    
    if (type === 'Bug') {
        if (lbl) lbl.innerHTML = 'Description / Steps <span style="color:red">*</span>';
        if (area) area.placeholder = 'Detailed steps to reproduce...';
        if (rowBugTriage) rowBugTriage.style.display = 'grid';
    } else if (type === 'User Story') {
        if (lbl) lbl.innerHTML = 'Story Description / Acceptance Criteria <span style="color:red">*</span>';
        if (area) area.placeholder = 'As a <role>, I want <capability>, so that <value>...';
        if (rowBugTriage) rowBugTriage.style.display = 'none';
    } else {
        if (lbl) lbl.innerHTML = 'Business Value / Requirements <span style="color:red">*</span>';
        if (area) area.placeholder = 'What is the benefit and requirement?';
        if (rowBugTriage) rowBugTriage.style.display = 'none';
    }
    
    addDebugLog(`Work item type switched to ${type}. State reset.`);
}

function toggleExpandDescription(event) {
    const area = document.getElementById('wi-description');
    const btn = event.currentTarget;
    if (!area) return;
    
    const isExpanded = area.getAttribute('data-expanded') === 'true';
    
    if (isExpanded) {
        area.style.height = '120px';
        area.setAttribute('data-expanded', 'false');
        btn.innerHTML = '⤢';
        btn.title = 'Expand';
    } else {
        area.style.height = '400px';
        area.setAttribute('data-expanded', 'true');
        btn.innerHTML = '⤡';
        btn.title = 'Collapse';
        area.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
}

function toggleUpdateMode(enabled) {
    bugAgentState.updateMode = enabled;
    const container = document.getElementById('update-id-container');
    if (container) {
        container.style.display = enabled ? 'block' : 'none';
        container.style.maxHeight = enabled ? '120px' : '0';
        container.style.marginBottom = enabled ? '12px' : '0';
        container.style.transition = 'all 0.3s ease';
    }
    const executeBtn = document.getElementById('btn-execute');
    if (executeBtn) {
        executeBtn.textContent = enabled ? '✏️ Update Work Item' : '▶ Execute Agent';
    }
    
    // Ensure form pane remains scrollable
    const formPane = document.getElementById('bug-form-scroll-pane');
    if (formPane) {
        formPane.style.overflowY = 'auto';
        formPane.style.maxHeight = '650px';
    }
}

async function fetchExistingWI() {
    const id = document.getElementById('update-work-item-id').value;
    if (!id) return;
    
    const status = document.getElementById('fetch-status');
    if (status) {
        status.textContent = '⏳ Fetching...';
        status.style.color = '#64748b';
    }
    
    try {
        const tfs = getEffectiveTFSConfig();
        const response = await fetch(`${API_BASE}/tfs/fetch-bug-details`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ bug_id: id, tfs_config: tfs })
        });
        const data = await response.json();
        if (data.success && data.bug_details) {
            const wi = data.bug_details;
            const titleEl = document.getElementById('wi-title');
            const descEl = document.getElementById('wi-description');
            const areaEl = document.getElementById('wi-area');
            const iterEl = document.getElementById('wi-iteration');
            const sevEl = document.getElementById('wi-severity');
            const prioEl = document.getElementById('wi-priority');
            const assignedEl = document.getElementById('wi-assigned');
            const tagsEl = document.getElementById('wi-tags');
            const storyLinkEl = document.getElementById('wi-story-link');
            
            if (titleEl) titleEl.value = wi.title || '';
            
            // Set description based on type
            if (descEl) {
                if (wi.work_item_type === 'Bug') {
                    descEl.value = (wi.reproduction_steps || wi.description || '');
                } else {
                    descEl.value = (wi.description || wi.reproduction_steps || '');
                }
            }
            if (areaEl) areaEl.value = wi.area_path || '';
            if (iterEl) iterEl.value = wi.iteration_path || '';
            if (sevEl) sevEl.value = wi.severity || '2 - High';
            if (prioEl) prioEl.value = wi.priority || '2';
            if (assignedEl) assignedEl.value = wi.assigned_to || '';
            if (tagsEl) tagsEl.value = wi.tags || '';
            
            // Populate story link if it exists
            if (storyLinkEl && wi.story_link_id) {
                storyLinkEl.value = wi.story_link_id;
                storyLinkEl.setAttribute('data-id', wi.story_link_id);
            }
            
            // Auto-detect type
            if (wi.work_item_type === 'Feature') {
                selectWIType('Feature');
            } else if (wi.work_item_type === 'User Story') {
                selectWIType('User Story');
            } else {
                selectWIType('Bug');
            }
            
            if (status) {
                status.textContent = '✅ Loaded successfully';
                status.style.color = '#059669';
            }
        } else {
            throw new Error(data.error || 'Work item not found');
        }
    } catch (e) {
        if (status) {
            status.textContent = `❌ ${e.message}`;
            status.style.color = '#ef4444';
        }
    }
}

function handleChatScreenshotUpload(input) {
    if (input.files) {
        const files = Array.from(input.files);
        let loadedCount = 0;
        
        files.forEach(file => {
            const reader = new FileReader();
            reader.onload = function(e) {
                bugAgentState.currentScreenshots.push({
                    name: file.name,
                    data: e.target.result
                });
                loadedCount++;
                if (loadedCount === files.length) {
                    renderScreenshotPreviews();
                }
            };
            reader.readAsDataURL(file);
        });
        
        // Clear input so same file can be selected again
        input.value = '';
    }
}

function renderScreenshotPreviews() {
    const previewCont = document.getElementById('chat-screenshot-preview-container');
    if (!previewCont) return;
    
    if (bugAgentState.currentScreenshots.length === 0) {
        previewCont.style.display = 'none';
        return;
    }
    
    previewCont.style.display = 'flex';
    previewCont.style.flexWrap = 'wrap';
    previewCont.style.gap = '8px';
    previewCont.innerHTML = '';
    
    bugAgentState.currentScreenshots.forEach((s, index) => {
        const item = document.createElement('div');
        item.style.position = 'relative';
        item.style.width = '80px';
        item.style.height = '60px';
        
        const img = document.createElement('img');
        img.src = s.data;
        img.style.width = '100%';
        img.style.height = '100%';
        img.style.objectFit = 'cover';
        img.style.borderRadius = '6px';
        img.style.border = '1px solid #e2e8f0';
        
        const btn = document.createElement('button');
        btn.innerHTML = '✕';
        btn.onclick = (e) => { e.preventDefault(); removeScreenshot(index); };
        btn.style.position = 'absolute';
        btn.style.top = '-5px';
        btn.style.right = '-5px';
        btn.style.background = '#ef4444';
        btn.style.color = 'white';
        btn.style.border = 'none';
        btn.style.borderRadius = '50%';
        btn.style.width = '18px';
        btn.style.height = '18px';
        btn.style.fontSize = '10px';
        btn.style.cursor = 'pointer';
        btn.style.display = 'flex';
        btn.style.alignItems = 'center';
        btn.style.justifyContent = 'center';
        
        item.appendChild(img);
        item.appendChild(btn);
        previewCont.appendChild(item);
    });
}

function removeScreenshot(index) {
    bugAgentState.currentScreenshots.splice(index, 1);
    renderScreenshotPreviews();
}

function clearChatScreenshot() {
    bugAgentState.currentScreenshots = [];
    renderScreenshotPreviews();
    const uploadInput = document.getElementById('bug-screenshot-upload');
    if (uploadInput) uploadInput.value = '';
}

async function sendChatMessage() {
    const input = document.getElementById('bug-chat-input');
    if (!input) return;
    const message = input.value.trim();
    const screenshots = [...bugAgentState.currentScreenshots]; // Copy current screenshots
    
    if (!message && screenshots.length === 0) return;
    
    // Add user bubble
    const messages = document.getElementById('bug-chat-messages');
    if (!messages) return;
    
    const userBubble = document.createElement('div');
    userBubble.className = 'chat-bubble user';
    
    if (message) {
        const textSpan = document.createElement('span');
        textSpan.textContent = message;
        userBubble.appendChild(textSpan);
    }
    
    if (screenshots.length > 0) {
        const imgCont = document.createElement('div');
        imgCont.style.display = 'flex';
        imgCont.style.flexWrap = 'wrap';
        imgCont.style.gap = '5px';
        imgCont.style.marginTop = '8px';
        
        screenshots.forEach(s => {
            const img = document.createElement('img');
            img.src = s.data;
            img.className = 'screenshot-preview';
            img.style.maxHeight = '120px';
            img.style.borderRadius = '5px';
            imgCont.appendChild(img);
        });
        userBubble.appendChild(imgCont);
    }
    
    messages.appendChild(userBubble);
    messages.scrollTop = messages.scrollHeight;
    
    input.value = '';
    // Store screenshots for the final TFS execution
    bugAgentState.formScreenshots = [...bugAgentState.formScreenshots, ...screenshots];
    clearChatScreenshot();
    
    // Show AI "typing"
    const aiBubble = document.createElement('div');
    aiBubble.className = 'chat-bubble ai';
    aiBubble.textContent = '⏳ Thinking...';
    messages.appendChild(aiBubble);
    messages.scrollTop = messages.scrollHeight;
    
    try {
        const response = await fetch(`${API_BASE}/agent/format-bug-report`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                bug_description: message,
                work_item_type: bugAgentState.wiType,
                screenshots: screenshots.map(s => ({ filename: s.name, data: s.data })),
                history: bugAgentState.history,
                llm_config: getLLMConfig()
            })
        });
        const data = await response.json();
        if (data.success) {
            console.log('🤖 AI Response Data:', data);
            aiBubble.innerHTML = `✅ I've structured your ${bugAgentState.wiType} details. Check the form on the right!`;

            // Update history
            bugAgentState.history.push({ role: 'user', content: message });
            bugAgentState.history.push({ role: 'assistant', content: data.formatted_report || '' });

            // USE DIRECT JSON DATA (Prioritize over parsing)
            const raw = data.data || {};
            const structuredData = {
                title: raw.title || '',
                description: raw.description || '',
                steps_to_reproduce: raw.reproduction_steps || '',
                actual_result: raw.actual_behavior || '',
                expected_result: raw.expected_behavior || '',
                business_value: bugAgentState.wiType === 'Feature' ? (raw.expected_behavior || '') : '',
                requirements: bugAgentState.wiType === 'Feature' ? (raw.reproduction_steps || '') : '',
                acceptance_criteria: raw.actual_behavior || raw.acceptance_criteria || '',
                severity: raw.severity || data.severity || '',
                priority: raw.priority || data.priority || ''
            };

            console.log('📋 Mapped Data for UI:', structuredData);

            // 1. Update Title
            if (structuredData.title) {
                document.getElementById('wi-title').value = structuredData.title;
            }

            // 2. Format description with specific bold headings and spacing
            let desc = '';
            if (bugAgentState.wiType === 'Bug') {
                desc = `**Description**\n${structuredData.description}\n\n` +
                       `**Steps to Reproduce**\n${structuredData.steps_to_reproduce}\n\n` +
                       `**Actual Result**\n${structuredData.actual_result}\n\n` +
                       `**Expected Result**\n${structuredData.expected_result}`;
            } else {
                // Feature mapping
                desc = `**Overview**\n${structuredData.description}\n\n` +
                       `**Business Value**\n${structuredData.business_value}\n\n` +
                       `**Requirements**\n${structuredData.requirements}\n\n` +
                       `**Acceptance Criteria**\n${structuredData.acceptance_criteria}`;
            }

            // 3. Set Description Value
            const descEl = document.getElementById('wi-description');
            if (descEl) {
                descEl.value = desc.trim();
                descEl.scrollTop = 0;
            }

            // 4. Auto-update Severity, Priority and Assigned To
            const sevVal = structuredData.severity;
            const prioVal = structuredData.priority;
            const assignedVal = raw.assigned_to || data.assigned_to;
            if (sevVal) {
                const sevEl = document.getElementById('wi-severity');
                if (sevEl) sevEl.value = String(sevVal).trim();
            }
            if (prioVal) {
                const prioEl = document.getElementById('wi-priority');
                if (prioEl) {
                    const cleanPrio = String(prioVal).trim().charAt(0);
                    if (['1','2','3','4'].includes(cleanPrio)) prioEl.value = cleanPrio;
                }
            }
            if (assignedVal) {
                const assignEl = document.getElementById('wi-assigned');
                if (assignEl) {
                    const valToSet = typeof assignedVal === 'object' ? 
                        (assignedVal.displayName || assignedVal.uniqueName || '') : 
                        String(assignedVal);
                    assignEl.value = valToSet;
                }
            }
        } else {
            throw new Error(data.error || 'AI failed to format');
        }
    } catch (e) {
        aiBubble.textContent = `❌ Error: ${e.message}`;
    }
    messages.scrollTop = messages.scrollHeight;
}

function parseBugReportFromAI(text) {
    console.log("🧐 parseBugReportFromAI starting. Length:", text.length);
    const result = { 
        title: '', description: '', steps_to_reproduce: '', 
        actual_result: '', expected_result: '',
        business_value: '', requirements: '', acceptance_criteria: '',
        assigned_to: '', severity: '', priority: ''
    };
    if (!text) return result;

    const lines = text.split('\n');
    let currentSection = null;
    let content = [];

    function saveSection() {
        if (currentSection && content.length > 0) {
            let val = content.join('\n').trim();
            
            // Detect and unpack stringified lists
            if (val.startsWith('[') && val.endsWith(']')) {
                try {
                    const inner = val.substring(1, val.length - 1).trim();
                    if (inner.startsWith("'") || inner.startsWith('"')) {
                        let items = [];
                        if (inner.includes("',") || inner.includes('",')) {
                            items = inner.split(/['"],\s*['"]/).map(i => i.replace(/^['"]|['"]$/g, '').trim());
                        } else {
                            items = [inner.replace(/^['"]|['"]$/g, '').trim()];
                        }
                        val = items.filter(i => i !== "").join('\n');
                    }
                } catch (e) {}
            }

            if (currentSection === 'title') result.title = val;
            else if (currentSection === 'description') result.description = val;
            else if (currentSection === 'steps') result.steps_to_reproduce = val;
            else if (currentSection === 'actual') result.actual_result = val;
            else if (currentSection === 'expected') result.expected_result = val;
            else if (currentSection === 'value') result.business_value = val;
            else if (currentSection === 'reqs') result.requirements = val;
            else if (currentSection === 'criteria') result.acceptance_criteria = val;
        }
        content = [];
    }

    const patterns = [
        { key: 'title', keywords: ['title', 'summary'] },
        { key: 'description', keywords: ['description', 'overview', 'problem', 'issue'] },
        { key: 'steps', keywords: ['steps to reproduce', 'reproduction steps', 'steps'] },
        { key: 'actual', keywords: ['actual result', 'actual behavior', 'actual'] },
        { key: 'expected', keywords: ['expected result', 'expected behavior', 'expected'] },
        { key: 'value', keywords: ['business value', 'value', 'benefit'] },
        { key: 'reqs', keywords: ['requirements', 'requirement'] },
        { key: 'criteria', keywords: ['acceptance criteria', 'criteria'] },
        { key: 'STOP', keywords: ['severity', 'priority', 'work item type'] }
    ];

    lines.forEach((line, idx) => {
        const trimmed = line.trim();
        if (!trimmed) {
            if (currentSection) content.push("");
            return;
        }

        const cleanLine = trimmed.replace(/\*/g, '').trim();
        let matched = false;
        
        for (const p of patterns) {
            for (const kw of p.keywords) {
                // Stricter Match: Keyword must be followed by colon/dash OR be the whole line
                const regex = new RegExp('^' + kw.replace(/\s+/g, '\\s+') + '(\\s*[:\\-].*|$)', 'i');
                const match = cleanLine.match(regex);
                
                if (match) {
                    // Safety check: if line is very long and has no colon, it's probably just a sentence
                    if (cleanLine.length > kw.length + 10 && !cleanLine.includes(':') && !cleanLine.includes('-')) {
                        continue;
                    }

                    console.log(`🎯 Match [${p.key}] at line ${idx+1}: ${cleanLine}`);
                    saveSection();
                    if (p.key === 'STOP') {
                        currentSection = null;
                    } else {
                        currentSection = p.key;
                        const remainder = cleanLine.substring(kw.length).replace(/^[:\-\s]+/, '').trim();
                        if (remainder) content.push(remainder);
                    }
                    matched = true;
                    break;
                }
            }
            if (matched) break;
        }

        if (!matched && currentSection) {
            content.push(line);
        }
    });
    
    saveSection();

    // Fallback Title
    if (!result.title && lines.length > 0) {
        for (const l of lines) {
            const clean = l.trim().replace(/\*/g, '');
            if (clean && !patterns.some(p => p.keywords.some(kw => clean.toLowerCase().startsWith(kw)))) {
                result.title = clean;
                break;
            }
        }
    }

    console.log("✅ Parsing complete. Populated keys:", Object.keys(result).filter(k => result[k]));
    return result;
}

function showDropdown(type) {
    const list = document.getElementById(`dropdown-${type}`);
    if (list) {
        list.style.display = 'block';
        filterDropdown(type, '');
    }
}

async function filterDropdown(type, query) {
    const list = document.getElementById(`dropdown-${type}`);
    if (!list) return;
    const q = query.toLowerCase();
    
    // For members, if query is provided, we should do a fresh search from backend
    if (type === 'members' && q.length >= 2) {
        list.innerHTML = '<div class="dropdown-item">⏳ Searching...</div>';
        try {
            const tfs = getEffectiveTFSConfig();
            const response = await fetch(`${API_BASE}/tfs/search-identities`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    search_query: q,
                    tfs_config: tfs
                })
            });
            const data = await response.json();
            if (data.success && data.identities) {
                // Update the cache so subsequent local filter works too
                const newMembers = data.identities.map(id => ({
                    display_name: id,
                    id: id,
                    email: id.includes('<') ? id.split('<')[1].replace('>', '') : ''
                }));
                
                if (newMembers.length > 0) {
                    list.innerHTML = newMembers.map(i => {
                        const val = i.display_name;
                        const safeVal = val.replace(/'/g, "\\'");
                        return `<div class="dropdown-item" onclick="selectDropdownItem('${type}', '${safeVal}', '${safeVal}')">
                            <span class="dropdown-item-title">${val}</span>
                        </div>`;
                    }).join('');
                    return;
                }
            }
        } catch (e) {
            console.warn('Backend search failed, falling back to local filter');
        }
    }

    let items = bugAgentState.dropdowns[type] || [];
    
    // Apply filtering
    let filtered = [];
    if (type === 'area' || type === 'iteration') {
        filtered = items.filter(i => (i.path || i).toLowerCase().includes(q)).slice(0, 50);
    } else if (type === 'members') {
        filtered = items.filter(i => (i.display_name || '').toLowerCase().includes(q) || (i.email || '').toLowerCase().includes(q)).slice(0, 50);
    } else if (type === 'stories') {
        filtered = items.filter(i => String(i.id).includes(q) || (i.title || '').toLowerCase().includes(q)).slice(0, 50);
    }
    
    if (filtered.length === 0 && q) {
        list.innerHTML = `<div class="dropdown-item" onclick="selectDropdownItem('${type}', '', '${q.replace(/'/g, "\\'")}')">Use manual: "${q}"</div>`;
    } else {
        list.innerHTML = filtered.map(i => {
            const val = i.path || i.display_name || i.title || i;
            const id = i.id || i.path || i;
            const sub = i.email || i.path || `#${i.id}` || '';
            const safeVal = val.replace(/'/g, "\\'");
            const safeId = String(id).replace(/'/g, "\\'");
            return `<div class="dropdown-item" onclick="selectDropdownItem('${type}', '${safeId}', '${safeVal}')">
                <span class="dropdown-item-title">${val}</span>
                <span class="dropdown-item-sub">${sub}</span>
            </div>`;
        }).join('');
    }
}

function selectDropdownItem(type, id, value) {
    let inputId = `wi-${type}`;
    if (type === 'stories') inputId = 'wi-story-link';
    if (type === 'members') inputId = 'wi-assigned';
    
    const input = document.getElementById(inputId);
    if (input) {
        input.value = value;
        input.setAttribute('data-id', id);
    }
    
    const list = document.getElementById(`dropdown-${type}`);
    if (list) list.style.display = 'none';
}

function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// Global click to close dropdowns
document.addEventListener('click', (e) => {
    if (!e.target.closest('.custom-dropdown-container')) {
        document.querySelectorAll('.custom-dropdown-list').forEach(l => l.style.display = 'none');
    }
});


