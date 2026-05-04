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


