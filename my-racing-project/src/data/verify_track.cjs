//!!!!!!!!!!!!! Just for verification !!!!!!!!!!!!!!!!!!!!!!
//!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!

const fs = require('fs');

const path = 'D:/Me/Coding/Python/racing-visualisation-d/my-racing-project/public/monaco_coords.json';
const data = JSON.parse(fs.readFileSync(path, 'utf8'));

function haversine(lon1, lat1, lon2, lat2) {
    const R = 6371e3; // metres
    const phi1 = lat1 * Math.PI/180;
    const phi2 = lat2 * Math.PI/180;
    const dphi = (lat2-lat1) * Math.PI/180;
    const dlam = (lon2-lon1) * Math.PI/180;

    const a = Math.sin(dphi/2) * Math.sin(dphi/2) +
              Math.cos(phi1) * Math.cos(phi2) *
              Math.sin(dlam/2) * Math.sin(dlam/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));

    return R * c; // in metres
}

let totalDistance = 0;
let maxJump = 0;
let maxJumpIdx = -1;

for (let i = 0; i < data.length - 1; i++) {
    const p1 = data[i];
    const p2 = data[i+1];
    const d = haversine(p1[0], p1[1], p2[0], p2[1]);
    totalDistance += d;
    if (d > maxJump) {
        maxJump = d;
        maxJumpIdx = i;
    }
}

const pStart = data[0];
const pEnd = data[data.length - 1];
const loopGap = haversine(pStart[0], pStart[1], pEnd[0], pEnd[1]);

console.log(`Total Points: ${data.length}`);
console.log(`Total Distance: ${(totalDistance / 1000).toFixed(3)} km`);
console.log(`Max jump between consecutive points: ${maxJump.toFixed(2)} metres (at index ${maxJumpIdx})`);
console.log(`Gap between start and end points (Loop check): ${loopGap.toFixed(2)} metres`);

if (loopGap > 50) {
    console.log("WARNING: The track does not seem to form a closed loop (gap > 50m).");
} else {
    console.log("SUCCESS: The track forms a closed loop.");
}

// Check against Monaco circuit length
const EXPECTED_LENGTH = 3.337;
const diff = Math.abs(totalDistance / 1000 - EXPECTED_LENGTH);
console.log(`Difference from official length (3.337 km): ${diff.toFixed(3)} km`);

