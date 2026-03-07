/**
 * LILA BLACK - Player Journey Visualizer
 * Core Application Logic
 */

class DataService {
    constructor() {
        this.baseUrl = 'data/';
        this.stats = null;
        this.matchesIndex = null;
        this.heatmaps = null;
    }

    async init() {
        try {
            const [stats, index, heatmaps] = await Promise.all([
                fetch(this.baseUrl + 'stats.json').then(r => r.json()),
                fetch(this.baseUrl + 'matches_index.json').then(r => r.json()),
                fetch(this.baseUrl + 'heatmaps.json').then(r => r.json())
            ]);
            this.stats = stats;
            this.matchesIndex = index;
            this.heatmaps = heatmaps;
            return true;
        } catch (e) {
            console.error('Failed to load initial data:', e);
            return false;
        }
    }

    async getMatchDetails(matchId) {
        try {
            const response = await fetch(`${this.baseUrl}matches/${matchId}.json`);
            return await response.json();
        } catch (e) {
            console.error(`Failed to load match ${matchId}:`, e);
            return null;
        }
    }
}

class MapEngine {
    constructor(canvases) {
        this.canvases = canvases; // { heatmap, trail, marker }
        this.ctx = {
            heatmap: canvases.heatmap.getContext('2d'),
            trail: canvases.trail.getContext('2d'),
            marker: canvases.marker.getContext('2d')
        };
        this.currentMap = null;
        this.config = {
            human: '#00f2ff',
            bot: '#ff9d00',
            kill: '#ff3e3e',
            loot: '#c4ff3e',
            storm: '#b13eff'
        };
    }

    setMap(mapId) {
        this.currentMap = mapId;
        const container = document.getElementById('map-image-layer');
        const ext = mapId === 'Lockdown' ? 'jpg' : 'png';
        container.style.backgroundImage = `url('minimaps/${mapId}_Minimap.${ext}')`;
        this.clearAll();
    }

    clearAll() {
        Object.values(this.ctx).forEach(ctx => ctx.clearRect(0, 0, 1024, 1024));
    }

    clearLayer(layer) {
        this.ctx[layer].clearRect(0, 0, 1024, 1024);
    }

    drawHeatmap(data, type) {
        const ctx = this.ctx.heatmap;
        this.clearLayer('heatmap');
        if (!data || !data[type]) return;

        const points = data[type];
        let color = 'rgba(0, 242, 255, 0.1)';
        let radius = 8;

        if (type === 'kills') { color = 'rgba(255, 62, 62, 0.2)'; radius = 12; }
        else if (type === 'deaths') { color = 'rgba(255, 100, 100, 0.2)'; radius = 12; }
        else if (type === 'traffic') { color = 'rgba(0, 242, 255, 0.05)'; radius = 5; }
        else if (type === 'loot') { color = 'rgba(196, 255, 62, 0.2)'; radius = 8; }
        else if (type === 'storm_deaths') { color = 'rgba(177, 62, 255, 0.3)'; radius = 15; }

        ctx.fillStyle = color;
        points.forEach(p => {
            ctx.beginPath();
            ctx.arc(p[0], p[1], radius, 0, Math.PI * 2);
            ctx.fill();
        });
    }

    drawPlayerTrails(players, currentTime, showHumans, showBots) {
        const ctx = this.ctx.trail;
        this.clearLayer('trail');

        Object.values(players).forEach(player => {
            if (player.bot && !showBots) return;
            if (!player.bot && !showHumans) return;

            // Filter points up to current time
            const path = player.trail.filter(pt => pt[0] <= currentTime);
            if (path.length < 2) return;

            ctx.beginPath();
            ctx.strokeStyle = player.bot ? this.config.bot : this.config.human;
            ctx.lineWidth = 2;
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';
            ctx.globalAlpha = 0.6;

            ctx.moveTo(path[0][1], path[0][2]);
            for (let i = 1; i < path.length; i++) {
                ctx.lineTo(path[i][1], path[i][2]);
            }
            ctx.stroke();
            ctx.globalAlpha = 1.0;

            // Draw current position shadow
            const last = path[path.length - 1];
            ctx.fillStyle = player.bot ? this.config.bot : this.config.human;
            ctx.beginPath();
            ctx.arc(last[1], last[2], 4, 0, Math.PI * 2);
            ctx.fill();
            
            // Glow effect for current position
            ctx.shadowBlur = 10;
            ctx.shadowColor = ctx.fillStyle;
            ctx.stroke();
            ctx.shadowBlur = 0;
        });
    }

    drawMarkers(events, currentTime) {
        const ctx = this.ctx.marker;
        this.clearLayer('marker');
        
        // Show markers that happened in the last 2 seconds (visual persistence)
        const windowSize = 2000;
        const visibleEvents = events.filter(e => e.t <= currentTime && e.t > currentTime - windowSize);

        visibleEvents.forEach(e => {
            const age = (currentTime - e.t) / windowSize;
            const alpha = 1 - age;
            
            ctx.globalAlpha = alpha;
            ctx.lineWidth = 2;
            
            let color = '#fff';
            let size = 6;
            
            if (e.type.includes('Kill')) { color = this.config.kill; size = 10; }
            else if (e.type.includes('KilledByStorm')) { color = this.config.storm; size = 10; }
            else if (e.type === 'Loot') { color = this.config.loot; size = 4; }

            ctx.fillStyle = color;
            ctx.strokeStyle = '#fff';
            
            if (e.type.includes('Kill')) {
                // Draw X for kills
                ctx.beginPath();
                ctx.moveTo(e.px - size, e.py - size);
                ctx.lineTo(e.px + size, e.py + size);
                ctx.moveTo(e.px + size, e.py - size);
                ctx.lineTo(e.px - size, e.py + size);
                ctx.stroke();
            } else {
                ctx.beginPath();
                ctx.arc(e.px, e.py, size, 0, Math.PI * 2);
                ctx.fill();
                ctx.stroke();
            }
        });
        ctx.globalAlpha = 1.0;
    }
}

class PlaybackEngine {
    constructor(updateCallback) {
        this.updateCallback = updateCallback;
        this.currentTime = 0;
        this.duration = 0;
        this.speed = 1;
        this.isPlaying = false;
        this.lastTimestamp = 0;
    }

    setDuration(d) {
        this.duration = d;
        this.currentTime = 0;
        this.lastTimestamp = 0;
    }

    play() {
        if (!this.duration) return;
        this.isPlaying = true;
        this.lastTimestamp = performance.now();
        requestAnimationFrame(this.loop.bind(this));
    }

    pause() {
        this.isPlaying = false;
    }

    seek(time) {
        this.currentTime = Math.max(0, Math.min(time, this.duration));
        this.updateCallback(this.currentTime);
    }

    loop(ts) {
        if (!this.isPlaying) return;

        const delta = ts - this.lastTimestamp;
        this.lastTimestamp = ts;

        this.currentTime += delta * this.speed;
        
        if (this.currentTime >= this.duration) {
            this.currentTime = this.duration;
            this.isPlaying = false;
        }

        this.updateCallback(this.currentTime);
        
        if (this.isPlaying) {
            requestAnimationFrame(this.loop.bind(this));
        }
    }
}

class App {
    constructor() {
        this.data = new DataService();
        this.map = new MapEngine({
            heatmap: document.getElementById('heatmap-canvas'),
            trail: document.getElementById('trail-canvas'),
            marker: document.getElementById('marker-canvas')
        });
        this.playback = new PlaybackEngine(this.onTick.bind(this));
        
        this.currentMatch = null;
        this.filters = {
            map: 'all',
            day: 'all',
            search: ''
        };
        
        this.options = {
            heatmap: false,
            heatmapType: 'traffic',
            trails: true,
            humans: true,
            bots: true
        };
    }

    async init() {
        const success = await this.data.init();
        if (!success) {
            alert('Failed to load data. Please check data files.');
            return;
        }

        this.populateFilters();
        this.updateStats();
        this.renderMatchList();
        this.bindEvents();
        
        // Hide loader
        document.getElementById('loader').style.opacity = '0';
        setTimeout(() => document.getElementById('loader').style.display = 'none', 500);
    }

    updateStats() {
        const s = this.data.stats;
        document.getElementById('stat-matches').textContent = s.total_matches;
        document.getElementById('stat-humans').textContent = s.total_human_players;
        document.getElementById('stat-bots').textContent = s.total_bots;
    }

    populateFilters() {
        const daySelect = document.getElementById('day-filter');
        this.data.stats.days.forEach(day => {
            const opt = document.createElement('option');
            opt.value = day;
            opt.textContent = day.replace('_', ' ');
            daySelect.appendChild(opt);
        });
    }

    renderMatchList() {
        const container = document.getElementById('match-list');
        container.innerHTML = '';
        
        const filtered = Object.values(this.data.matchesIndex).filter(m => {
            if (this.filters.map !== 'all' && m.map !== this.filters.map) return false;
            if (this.filters.day !== 'all' && m.day !== this.filters.day) return false;
            if (this.filters.search && !m.id.toLowerCase().includes(this.filters.search.toLowerCase())) return false;
            return true;
        });

        document.getElementById('match-count-label').textContent = filtered.length;

        filtered.forEach(m => {
            const div = document.createElement('div');
            div.className = `match-item ${this.currentMatch?.id === m.id ? 'active' : ''}`;
            div.innerHTML = `
                <div class="match-name">${m.map} - ${m.id.substring(0, 8)}...</div>
                <div class="match-meta">
                    <span>${m.humans} Humans | ${m.bots} Bots</span>
                    <span>${Math.floor(m.duration_s / 60)}:${(Math.floor(m.duration_s % 60)).toString().padStart(2, '0')}</span>
                </div>
            `;
            div.onclick = () => this.selectMatch(m.id);
            container.appendChild(div);
        });
    }

    async selectMatch(matchId) {
        this.playback.pause();
        const details = await this.data.getMatchDetails(matchId);
        if (!details) return;

        this.currentMatch = {
            index: this.data.matchesIndex[matchId],
            details: details
        };

        // UI Updates
        document.querySelectorAll('.match-item').forEach(el => el.classList.remove('active'));
        const index = Object.keys(this.data.matchesIndex).indexOf(matchId);
        // (Simplification: just re-render list to show active)
        this.renderMatchList();

        document.getElementById('current-match-id').textContent = `MATCH ID: ${matchId} | MAP: ${this.currentMatch.index.map}`;
        document.getElementById('total-time').textContent = this.formatTime(details.duration);
        document.getElementById('time-slider').max = details.duration;
        document.getElementById('btn-play').innerHTML = `<svg viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="M8,5.14V19.14L19,12.14L8,5.14Z" /></svg>`;

        this.map.setMap(this.currentMatch.index.map);
        this.playback.setDuration(details.duration);
        
        // Render timeline markers
        this.renderTimelineMarkers();
        
        // Initial drawing
        this.onTick(0);
        
        // Auto-disable individual heatmap if switching match, or keep it? 
        // Let's force redraw heatmap if it's on
        if (this.options.heatmap) this.updateHeatmap();
    }

    renderTimelineMarkers() {
        const container = document.getElementById('event-markers-timeline');
        container.innerHTML = '';
        const dur = this.currentMatch.details.duration;
        
        this.currentMatch.details.events.forEach(e => {
            const div = document.createElement('div');
            div.className = `timeline-event ${e.type}`;
            div.style.left = `${(e.t / dur) * 100}%`;
            container.appendChild(div);
        });
    }

    onTick(time) {
        if (!this.currentMatch) return;
        
        document.getElementById('time-slider').value = time;
        document.getElementById('current-time').textContent = this.formatTime(time);
        
        // Update live stats (kills at this point)
        const killsSoFar = this.currentMatch.details.events.filter(e => e.t <= time && e.type.includes('Kill')).length;
        const deathsSoFar = this.currentMatch.details.events.filter(e => e.t <= time && e.type.includes('Killed')).length;
        document.getElementById('match-live-stats').textContent = `COMBAT EVENTS: ${killsSoFar + deathsSoFar}`;

        this.map.drawPlayerTrails(
            this.currentMatch.details.players, 
            time, 
            this.options.humans, 
            this.options.bots
        );
        
        this.map.drawMarkers(this.currentMatch.details.events, time);
    }

    updateHeatmap() {
        if (!this.options.heatmap || !this.map.currentMap) {
            this.map.clearLayer('heatmap');
            return;
        }
        const data = this.data.heatmaps[this.map.currentMap];
        this.map.drawHeatmap(data, this.options.heatmapType);
    }

    formatTime(ms) {
        const s = Math.floor(ms / 1000);
        const m = Math.floor(s / 60);
        return `${m}:${(s % 60).toString().padStart(2, '0')}`;
    }

    bindEvents() {
        // Filters
        document.getElementById('map-filter').onchange = (e) => {
            this.filters.map = e.target.value;
            this.renderMatchList();
            // If heatmap is on, switch map heatmap even without match
            if (this.filters.map !== 'all') {
                this.map.setMap(this.filters.map);
                this.updateHeatmap();
            }
        };
        document.getElementById('day-filter').onchange = (e) => {
            this.filters.day = e.target.value;
            this.renderMatchList();
        };
        document.getElementById('match-search').oninput = (e) => {
            this.filters.search = e.target.value;
            this.renderMatchList();
        };

        // Playback
        document.getElementById('btn-play').onclick = () => {
            if (this.playback.isPlaying) {
                this.playback.pause();
                document.getElementById('btn-play').innerHTML = `<svg viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="M8,5.14V19.14L19,12.14L8,5.14Z" /></svg>`;
            } else {
                this.playback.play();
                document.getElementById('btn-play').innerHTML = `<svg viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="M14,19H18V5H14M6,19H10V5H6V19Z" /></svg>`;
            }
        };

        document.getElementById('time-slider').oninput = (e) => {
            this.playback.seek(parseInt(e.target.value));
        };

        document.querySelectorAll('.speed-btn').forEach(btn => {
            btn.onclick = () => {
                document.querySelectorAll('.speed-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                this.playback.speed = parseFloat(btn.dataset.speed);
            };
        });

        // Toggles
        document.getElementById('toggle-heatmap').onchange = (e) => {
            this.options.heatmap = e.target.checked;
            document.getElementById('heatmap-type').disabled = !e.target.checked;
            this.updateHeatmap();
        };
        document.getElementById('heatmap-type').onchange = (e) => {
            this.options.heatmapType = e.target.value;
            this.updateHeatmap();
        };
        document.getElementById('toggle-humans').onchange = (e) => {
            this.options.humans = e.target.checked;
            this.onTick(this.playback.currentTime);
        };
        document.getElementById('toggle-bots').onchange = (e) => {
            this.options.bots = e.target.checked;
            this.onTick(this.playback.currentTime);
        };

        // Map mouse move (tooltip)
        const viewport = document.getElementById('map-viewport');
        const tooltip = document.getElementById('tooltip');
        viewport.onmousemove = (e) => {
            // Check for nearby points? (Simplified for now - just show coords)
            // In a real tool, we'd hittest the players
            tooltip.classList.remove('hidden');
            tooltip.style.left = (e.clientX + 10) + 'px';
            tooltip.style.top = (e.clientY + 10) + 'px';
            
            // Map coord calc
            const rect = viewport.getBoundingClientRect();
            const x = Math.round((e.clientX - rect.left - (rect.width - 1024)/2));
            const y = Math.round((e.clientY - rect.top - (rect.height - 1024)/2));
            if (x >= 0 && x <= 1024 && y >= 0 && y <= 1024) {
                tooltip.textContent = `Pix: ${x}, ${y}`;
            } else {
                tooltip.classList.add('hidden');
            }
        };
        viewport.onmouseleave = () => tooltip.classList.add('hidden');
    }
}

// Start app
window.onload = () => {
    const app = new App();
    app.init();
};
