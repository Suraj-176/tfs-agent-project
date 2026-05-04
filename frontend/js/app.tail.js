            
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


