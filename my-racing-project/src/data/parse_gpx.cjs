const fs = require('fs');
const { DOMParser } = require('@xmldom/xmldom');

const GPX_PATH = 'D:/Me/Coding/Python/racing-visualisation-d/my-racing-project/src/data/export.gpx';
const OUTPUT_PATH = 'D:/Me/Coding/Python/racing-visualisation-d/my-racing-project/public/monaco_coords.json';

const gpxText = fs.readFileSync(GPX_PATH, 'utf-8');
const doc = new DOMParser().parseFromString(gpxText, 'text/xml');

const EXCLUDE_NAMES = new Set(['Voie des stands', 'Sortie des stands']);

// Get only track (by teg)
const segments = [];
const trks = doc.getElementsByTagName('trk');

// extract coordinates
for (let t = 0; t < trks.length; t++) {
    const trk = trks[t];
    const nameEl = trk.getElementsByTagName('name')[0];
    const name = nameEl ? nameEl.textContent.trim() : 'Unknown';

    // Include everything except excluded names - technical parts
    if (EXCLUDE_NAMES.has(name)) continue;

    const trksegs = trk.getElementsByTagName('trkseg');
    for (let s = 0; s < trksegs.length; s++) {
        const pts = [];
        const trkpts = trksegs[s].getElementsByTagName('trkpt');
        for (let p = 0; p < trkpts.length; p++) {
            const lon = parseFloat(trkpts[p].getAttribute('lon'));
            const lat = parseFloat(trkpts[p].getAttribute('lat'));
            pts.push([lon, lat]);
        }
        if (pts.length >= 2) {
            segments.push({ name, pts });
        }
    }
}

// Deduplicate (sometimes GPS does duplicates of the same segment)
const unique = [];
const seen = new Set();

for (const seg of segments) {
    const fwd = JSON.stringify(seg.pts);
    const rev = JSON.stringify([...seg.pts].reverse());
    if (!seen.has(fwd) && !seen.has(rev)) {
        seen.add(fwd);
        unique.push(seg);
    }
}

if (unique.length === 0) {
    process.exit(1);
}

function dist(a, b) {
    return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

const path = [...unique[0].pts];
const used = new Set([0]);

// stiching neibouring segments together
for (let step = 0; step < unique.length - 1; step++) {
    const end = path[path.length - 1];
    let bestIdx = -1;
    let bestDist = Infinity;
    let bestRev = false;

    for (let i = 0; i < unique.length; i++) {
        if (used.has(i)) continue;
        const seg = unique[i].pts;
        const dStart = dist(end, seg[0]);
        const dEnd   = dist(end, seg[seg.length - 1]);

        if (dStart < bestDist) {
            bestDist = dStart;
            bestIdx = i;
            bestRev = false;
        }
        if (dEnd < bestDist) {
            bestDist = dEnd;
            bestIdx = i;
            bestRev = true;
        }
    }

    // too big gap is found, error in data
    if (bestIdx < 0 || bestDist > 0.00005) {
        console.log(`Stopped at step ${step}: gap ${bestDist.toFixed(6)}° too large`);
        break;
    }

    used.add(bestIdx);
    const pts = bestRev ? [...unique[bestIdx].pts].reverse() : unique[bestIdx].pts;

    if (dist(path[path.length - 1], pts[0]) < 1e-7) {
        path.push(...pts.slice(1));
    } else {
        path.push(...pts);
    }
}

console.log(`Stitched ${used.size} out of ${unique.length} 'Circuit de Monaco' segments.`);

fs.writeFileSync(OUTPUT_PATH, JSON.stringify(path));
