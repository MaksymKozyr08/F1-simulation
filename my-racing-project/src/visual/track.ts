import * as THREE from 'three';

export function createTrack(points: THREE.Vector3[]) {

    // Window smothing algorithm for points
    const windowSize = 10;
    const smoothedPoints: THREE.Vector3[] = [];
    const len = points.length;
    
    for (let i = 0; i < len; i++) {
        const sum = new THREE.Vector3();
        let count = 0;
        for (let j = -windowSize; j <= windowSize; j++) {
            // Use modulo for closed loop wrap-around
            let idx = (i + j + len) % len;
            sum.add(points[idx]);
            count++;
        }
        smoothedPoints.push(sum.divideScalar(count));
    }

    // create curve and break into equal pieces
    const curve = new THREE.CatmullRomCurve3(smoothedPoints, true, 'centripetal', 0.5);
    const curvePoints = curve.getSpacedPoints(3500);
    
    const trackGroup = new THREE.Group();

    // Main track
    const centerGeometry = new THREE.BufferGeometry().setFromPoints(curvePoints);
    const centerMaterial = new THREE.LineBasicMaterial({ 
        color: 0xf5f5f5, 
        transparent: true, 
        opacity: 0.8 
    });
    const centerLine = new THREE.Line(centerGeometry, centerMaterial);

    trackGroup.add(centerLine);

    // Borders
    const dashMaterial = new THREE.LineDashedMaterial({
        color: 0x808080,
        dashSize: 1,
        gapSize: 0.5,
        transparent: true,
        opacity: 0.4
    });
    
    const sidePoints1: THREE.Vector3[] = [];
    const sidePoints2: THREE.Vector3[] = [];
    const roadWidth = 2;
    
    for (let i = 0; i < curvePoints.length; i++) { 

        const point = curvePoints[i]; 
        const prev = curvePoints[i - 1] ?? curvePoints[i]; 

        // calculate using normal
        const tangent = point.clone().sub(prev).normalize(); 
        const normal = new THREE.Vector3(-tangent.z, 0, tangent.x).normalize(); 

        const p1 = point.clone().add(normal.clone().multiplyScalar(roadWidth)); 
        const p2 = point.clone().add(normal.clone().multiplyScalar(-roadWidth)); 

        p1.y = 0.01; 
        p2.y = 0.01;

        sidePoints1.push(p1); 
        sidePoints2.push(p2); 
    }

    const sideLine1 = new THREE.Line(new THREE.BufferGeometry().setFromPoints(sidePoints1), dashMaterial);
    const sideLine2 = new THREE.Line(new THREE.BufferGeometry().setFromPoints(sidePoints2), dashMaterial);

    sideLine1.computeLineDistances();
    sideLine2.computeLineDistances();


    trackGroup.add(sideLine1, sideLine2);

    //!!!!!!!!!!!!!!!!!!!!! Add optimal trajectory here !!!!!!!!!!!!!!!!!!!
    
    return { trackGroup, curve };
}