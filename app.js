/**
 * Glaucoma Visual Field Test Logic (Perimetry Simulator)
 * SITA-Standard 24-2 Medical Emulation — Enhanced 2-Round Threshold
 */

// === State ===
let state = 'welcome';
let stimulusTimeout;
let responseWindowTimeout;
let testPoints = [];
let stimulusQueue    = [];   // { pointIndex, round, opacity }[]
let currentQueueIndex = -1;
let round1Length     = 0;
let currentRound     = 1;
let canRespond       = false;
let lastDotFlashedAt = 0;
let lastReactionTime = 0;

// === Constants ===
const STIMULUS_DURATION = 200;   // Goldmann III standard: exactly 200ms
const RESPONSE_WINDOW   = 1400;  // Per-stimulus response window
const GOLDMANN_III_PX   = 6;     // ~0.43° diameter
let   DEG_TO_PX         = 7;     // Calibrated dynamically

// Luminance levels simulated via CSS opacity
// Round 1: medium (0.45–0.62) — baseline detection
// Round 2 seen:     dim  (0.16–0.30) — threshold refinement (harder)
// Round 2 not seen: bright (0.78–0.93) — confirm real defect (easier)
const LUM_MID_MIN  = 0.45; const LUM_MID_MAX  = 0.62;
const LUM_HARD_MIN = 0.16; const LUM_HARD_MAX = 0.30;
const LUM_EASY_MIN = 0.78; const LUM_EASY_MAX = 0.93;

// Sensitivity score: 4-level threshold map
// R1=T, R2=T → 1.00  (saw medium AND dim  → excellent)
// R1=T, R2=F → 0.65  (saw medium, not dim → good)
// R1=F, R2=T → 0.35  (not medium, saw bright → reduced)
// R1=F, R2=F → 0.00  (saw nothing → defect)

// === DOM ===
const stimulusContainer = document.getElementById('stimulus-container');
const screenTest        = document.getElementById('test-screen');
const canvas            = document.getElementById('result-canvas');
const ctx               = canvas.getContext('2d');

// === Focus Management ===
const enforceFocus = () => {
    document.body.tabIndex = -1;
    document.body.style.outline = 'none';
    window.focus();
    document.body.focus();
};
window.onload = enforceFocus;
window.addEventListener('focus', enforceFocus);
document.addEventListener('visibilitychange', () => { if (!document.hidden) enforceFocus(); });
document.addEventListener('click', enforceFocus);

// === Keyboard Handler ===
window.addEventListener('keydown', (e) => {
    const key  = e.key  ? e.key.toLowerCase() : '';
    const code = e.code || '';
    const isFound = code === 'KeyF' || key === 'f' || key === 'ㄹ' || e.keyCode === 70;
    const isStart = code === 'Enter' || code === 'KeyS'
                 || key === 'enter'  || key === 's'  || key === 'ㄴ'
                 || e.keyCode === 13 || e.keyCode === 83;

    if (isFound && state === 'testing') {
        e.preventDefault();
        recordResponse();
    } else if (isStart && (state === 'welcome' || state === 'result')) {
        e.preventDefault();
        startTest();
    }
});

// === Utilities ===
function switchScreen(id) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    document.getElementById(id).classList.add('active');
}

function shuffleArray(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

/**
 * Irregular inter-stimulus interval (ISI).
 * Mimics clinical SITA-Fast variance to prevent anticipatory responses.
 * Distribution: 20% short (200–500ms) / 65% normal (500–1400ms) / 15% long (1500–3000ms)
 */
function getISI() {
    const r = Math.random();
    if (r < 0.20) return 200  + Math.random() * 300;   // short:  200–500ms
    if (r < 0.85) return 500  + Math.random() * 900;   // normal: 500–1400ms
    return              1500  + Math.random() * 1500;   // long:  1500–3000ms
}

function getJetColor(v) {
    v = Math.max(0, Math.min(1, v));
    const r = Math.max(0, Math.min(1, 1.5 - Math.abs(4 * v - 3)));
    const g = Math.max(0, Math.min(1, 1.5 - Math.abs(4 * v - 2)));
    const b = Math.max(0, Math.min(1, 1.5 - Math.abs(4 * v - 1)));
    return `rgb(${Math.floor(r*255)},${Math.floor(g*255)},${Math.floor(b*255)})`;
}

// === Test Point Generation (SITA 24-2 Grid) ===
function generateTestPoints() {
    testPoints = [];

    // Precise integer center — avoids half-pixel misalignment
    const cx = Math.round(window.innerWidth  / 2);
    const cy = Math.round(window.innerHeight / 2);

    // Calibrate DEG_TO_PX so 30° fills 45% of the smaller screen dimension
    const maxR = Math.min(window.innerWidth, window.innerHeight) * 0.45;
    DEG_TO_PX  = maxR / 30;

    const yLevels = [21, 15, 9, 3, -3, -9, -15, -21];
    const xLevels = [-27, -21, -15, -9, -3, 3, 9, 15, 21, 27];

    for (const yDeg of yLevels) {
        for (const xDeg of xLevels) {
            const ay = Math.abs(yDeg), ax = Math.abs(xDeg);
            // Standard 24-2 oval field corner trimming
            if (ay === 21 && ax > 9)  continue;
            if (ay === 15 && ax > 15) continue;
            if (ay === 9  && ax > 21) continue;

            testPoints.push({
                // Integer pixel positions for crisp, blur-free rendering
                x: Math.round(cx + xDeg * DEG_TO_PX),
                y: Math.round(cy - yDeg * DEG_TO_PX),
                xDeg, yDeg,
                size: GOLDMANN_III_PX,
                // Round 1 luminance (medium range, unique per point)
                r1Opacity: LUM_MID_MIN + Math.random() * (LUM_MID_MAX - LUM_MID_MIN),
                r1Seen: null,
                // Round 2 values filled in after round 1
                r2Opacity: null,
                r2Seen: null,
                sensitivityScore: 0,
            });
        }
    }
}

// === Test Flow ===
function startTest() {
    state = 'testing';
    switchScreen('test-screen');
    stimulusContainer.innerHTML = '';

    generateTestPoints();

    // Build shuffled round 1 queue
    stimulusQueue = shuffleArray(
        testPoints.map((pt, i) => ({ pointIndex: i, round: 1, opacity: pt.r1Opacity }))
    );
    round1Length      = stimulusQueue.length;
    currentQueueIndex = -1;
    currentRound      = 1;

    // Boundary ring
    let ring = document.getElementById('boundary-ring');
    if (!ring) {
        ring = document.createElement('div');
        ring.id = 'boundary-ring';
        Object.assign(ring.style, {
            position: 'absolute', top: '50%', left: '50%',
            transform: 'translate(-50%,-50%)',
            border: '2px dashed rgba(255,255,255,0.2)',
            borderRadius: '50%', pointerEvents: 'none',
            transition: 'border-color 0.2s ease, box-shadow 0.2s ease',
        });
        screenTest.appendChild(ring);
    }
    const diam = Math.round(30 * DEG_TO_PX * 2);
    ring.style.width  = `${diam}px`;
    ring.style.height = `${diam}px`;
    ring.style.borderColor = 'rgba(255,255,255,0.2)';
    ring.style.boxShadow = 'none';

    clearTimeout(stimulusTimeout);
    clearTimeout(responseWindowTimeout);
    canRespond = false;

    // Initial fixation period
    setTimeout(nextStimulus, 2000);
}

function buildAndAppendRound2() {
    const round2 = testPoints.map((pt, i) => {
        let opacity;
        if (pt.r1Seen) {
            // Seen at medium → harder (dimmer) — tests true threshold sensitivity
            opacity = LUM_HARD_MIN + Math.random() * (LUM_HARD_MAX - LUM_HARD_MIN);
        } else {
            // Not seen at medium → easier (brighter) — confirms true defect vs. miss
            opacity = LUM_EASY_MIN + Math.random() * (LUM_EASY_MAX - LUM_EASY_MIN);
        }
        pt.r2Opacity = opacity;
        return { pointIndex: i, round: 2, opacity };
    });
    shuffleArray(round2);
    stimulusQueue = stimulusQueue.concat(round2);
}

function computeSensitivityScores() {
    testPoints.forEach(pt => {
        const s1 = pt.r1Seen === true;
        const s2 = pt.r2Seen === true;
        if      ( s1 &&  s2) pt.sensitivityScore = 1.00;
        else if ( s1 && !s2) pt.sensitivityScore = 0.65;
        else if (!s1 &&  s2) pt.sensitivityScore = 0.35;
        else                 pt.sensitivityScore = 0.00;
    });
}

function nextStimulus() {
    if (state !== 'testing') return;
    currentQueueIndex++;

    // Round 1 → Round 2 transition
    if (currentRound === 1 && currentQueueIndex === round1Length) {
        buildAndAppendRound2();
        currentRound = 2;
        setTimeout(nextStimulus, 1500); // brief inter-round pause
        return;
    }

    // All stimuli complete
    if (currentQueueIndex >= stimulusQueue.length) {
        computeSensitivityScores();
        endTest();
        return;
    }

    const item  = stimulusQueue[currentQueueIndex];
    const point = testPoints[item.pointIndex];
    canRespond  = false;

    // Create stimulus element — hidden until ISI elapses
    const el = document.createElement('div');
    el.className = 'stimulus';
    el.style.left      = `${point.x}px`;
    el.style.top       = `${point.y}px`;
    el.style.width     = `${point.size}px`;
    el.style.height    = `${point.size}px`;
    el.style.opacity   = '0';
    el.style.boxShadow = `0 0 ${point.size * 1.5}px rgba(255,255,255,0.45)`;
    stimulusContainer.appendChild(el);

    stimulusTimeout = setTimeout(() => {
        // Flash at threshold-level opacity (inline style for per-stimulus luminance control)
        el.style.opacity = String(item.opacity);
        canRespond       = true;
        lastDotFlashedAt = Date.now();

        // Auto-hide after Goldmann-standard 200ms
        setTimeout(() => {
            el.style.opacity = '0';
            setTimeout(() => { if (el.parentNode) el.remove(); }, 150);
        }, STIMULUS_DURATION);

        // No-response timeout → mark not-seen and advance
        responseWindowTimeout = setTimeout(() => {
            if (item.round === 1 && point.r1Seen === null) point.r1Seen = false;
            if (item.round === 2 && point.r2Seen === null) point.r2Seen = false;
            canRespond = false;
            nextStimulus();
        }, RESPONSE_WINDOW);

    }, getISI());
}

function recordResponse() {
    if (state !== 'testing') return;

    const now = Date.now();
    if (now - lastReactionTime < 250) return; // debounce double-presses
    lastReactionTime = now;

    // --- Immediate visual feedback ---
    const fixation = document.querySelector('.fixation-target');
    const ring     = document.getElementById('boundary-ring');
    if (fixation) {
        fixation.classList.remove('flash');
        void fixation.offsetWidth; // force reflow to reset CSS transition
        fixation.classList.add('flash');
        setTimeout(() => fixation.classList.remove('flash'), 200);
    }
    if (ring) {
        ring.style.borderColor = 'rgba(16,185,129,1)';
        ring.style.boxShadow   = '0 0 20px rgba(16,185,129,0.5)';
        setTimeout(() => {
            ring.style.borderColor = 'rgba(255,255,255,0.2)';
            ring.style.boxShadow   = 'none';
        }, 200);
    }

    // --- Score active stimulus ---
    if (canRespond && currentQueueIndex >= 0 && currentQueueIndex < stimulusQueue.length) {
        const item  = stimulusQueue[currentQueueIndex];
        const point = testPoints[item.pointIndex];
        const field = item.round === 1 ? 'r1Seen' : 'r2Seen';

        if (point[field] === null) {
            point[field] = true;
            canRespond   = false;
            clearTimeout(responseWindowTimeout);
            // Instantly hide stimulus for confirmed visual feedback
            document.querySelectorAll('.stimulus').forEach(el => el.style.opacity = '0');
            setTimeout(nextStimulus, 120);
            return;
        }
    }

    // --- Late-hit leniency (≤2000ms since last flash) ---
    if (!canRespond && currentQueueIndex > 0) {
        const elapsed   = now - lastDotFlashedAt;
        if (elapsed < 2000) {
            const prevItem  = stimulusQueue[currentQueueIndex - 1];
            const prevPoint = testPoints[prevItem.pointIndex];
            const field     = prevItem.round === 1 ? 'r1Seen' : 'r2Seen';
            if (prevPoint && prevPoint[field] === null) prevPoint[field] = true;
        }
    }
}

function endTest() {
    state = 'result';
    switchScreen('result-screen');
    drawResultsTable();
}

// === Result Visualization (IDW Topography) ===
function drawResultsTable() {
    const w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    const cx = w / 2, cy = h / 2;
    const SCALE = (w * 0.45) / 30; // degrees → canvas pixels

    // Patient data using continuous 4-level sensitivity score
    const data = testPoints.map(p => ({
        x: cx + p.xDeg * SCALE,
        y: cy - p.yDeg * SCALE,
        v: p.sensitivityScore,
    }));

    // Physiological blind spot (right eye: ~15° temporal, ~1.5° inferior)
    data.push({ x: cx + 15 * SCALE, y: cy + 1.5 * SCALE, v: 0.0 });

    // Edge normalisation ring
    for (let a = 0; a < Math.PI * 2; a += Math.PI / 8) {
        data.push({
            x: cx + 34 * SCALE * Math.cos(a),
            y: cy - 34 * SCALE * Math.sin(a),
            v: 0.8,
        });
    }

    const res  = 2;
    const maxR = 30 * SCALE;

    for (let y = 0; y < h; y += res) {
        for (let x = 0; x < w; x += res) {
            if (Math.hypot(x - cx, y - cy) > maxR) continue;
            let num = 0, den = 0, exact = -1;
            for (const p of data) {
                const d = Math.hypot(x - p.x, y - p.y);
                if (d < 1) { exact = p.v; break; }
                const wi = 1 / Math.pow(d, 3);
                num += p.v * wi;
                den += wi;
            }
            ctx.fillStyle = getJetColor(exact >= 0 ? exact : num / den);
            ctx.fillRect(x, y, res, res);
        }
    }

    // Degree rings
    ctx.strokeStyle = 'rgba(255,255,255,0.4)';
    ctx.lineWidth   = 1;
    ctx.setLineDash([4, 4]);
    [10, 20, 30].forEach(d => {
        ctx.beginPath();
        ctx.arc(cx, cy, d * SCALE, 0, Math.PI * 2);
        ctx.stroke();
    });

    // Crosshair
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(cx - 10, cy); ctx.lineTo(cx + 10, cy);
    ctx.moveTo(cx, cy - 10); ctx.lineTo(cx, cy + 10);
    ctx.stroke();

    // Outer boundary
    ctx.lineWidth   = 3;
    ctx.strokeStyle = '#fff';
    ctx.beginPath();
    ctx.arc(cx, cy, maxR, 0, Math.PI * 2);
    ctx.stroke();
}
