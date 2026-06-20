import * as THREE from 'three';

export function createTrack(points: THREE.Vector3[]) {
    const curve = new THREE.CatmullRomCurve3(points, true);
    const curvePoints = curve.getSpacedPoints(1000);
    const n = curvePoints.length;
    
    const trackGroup = new THREE.Group();

    // Central Line with slight elevation to prevent Z-fighting
    const centerPoints = curvePoints.map(p => {
        const cp = p.clone();
        cp.y += 0.02;
        return cp;
    });
    const centerGeometry = new THREE.BufferGeometry().setFromPoints(centerPoints);
    const centerMaterial = new THREE.LineBasicMaterial({ 
        color: 0xffffff, 
        transparent: true, 
        opacity: 1.0 
    });
    const centerLine = new THREE.Line(centerGeometry, centerMaterial);

    trackGroup.add(centerLine);

    // Dashed boundaries with slight elevation to prevent Z-fighting
    const dashMaterial = new THREE.LineDashedMaterial({
        color: 0xffffff,
        dashSize: 1,
        gapSize: 0.5,
        transparent: true,
        opacity: 1.0
    });
    
    const sidePoints1: THREE.Vector3[] = [];
    const sidePoints2: THREE.Vector3[] = [];
    const roadWidth = 1.0;
    const borderThickness = 0.09;
    
    for (let i = 0; i < n; i++) { 
        const point = curvePoints[i]; 
        const prev = curvePoints[(i - 1 + n) % n]; 
        const next = curvePoints[(i + 1) % n];

        const tangent = next.clone().sub(prev).normalize(); 
        const normal = new THREE.Vector3(-tangent.z, 0, tangent.x).normalize(); 

        const p1 = point.clone().add(normal.clone().multiplyScalar(roadWidth)); 
        const p2 = point.clone().add(normal.clone().multiplyScalar(-roadWidth)); 

        p1.y = point.y + 0.02; 
        p2.y = point.y + 0.02;

        sidePoints1.push(p1); 
        sidePoints2.push(p2); 
    }

    const sideLine1 = new THREE.Line(new THREE.BufferGeometry().setFromPoints(sidePoints1), dashMaterial);
    const sideLine2 = new THREE.Line(new THREE.BufferGeometry().setFromPoints(sidePoints2), dashMaterial);

    sideLine1.computeLineDistances();
    sideLine2.computeLineDistances();

    trackGroup.add(sideLine1, sideLine2);

    // --- Build 3D Road Mesh ---
    const roadPositions: number[] = [];
    const roadIndices: number[] = [];
    
    for (let i = 0; i < n; i++) {
        const p1 = sidePoints1[i].clone();
        const p2 = sidePoints2[i].clone();
        p1.y -= 0.015;
        p2.y -= 0.015;
        roadPositions.push(p1.x, p1.y, p1.z);
        roadPositions.push(p2.x, p2.y, p2.z);
    }
    
    for (let i = 0; i < n; i++) {
        const next = (i + 1) % n;
        const currLeft = 2 * i;
        const currRight = 2 * i + 1;
        const nextLeft = 2 * next;
        const nextRight = 2 * next + 1;
        
        roadIndices.push(currLeft, nextLeft, currRight);
        roadIndices.push(currRight, nextLeft, nextRight);
    }
    
    const roadGeometry = new THREE.BufferGeometry();
    roadGeometry.setAttribute('position', new THREE.Float32BufferAttribute(roadPositions, 3));
    roadGeometry.setIndex(roadIndices);
    roadGeometry.computeVertexNormals();
    
    const roadMaterial = new THREE.MeshStandardMaterial({
        color: 0xffffff, // Clean white track road
        roughness: 0.85,
        metalness: 0.1,
        side: THREE.DoubleSide
    });
    const roadMesh = new THREE.Mesh(roadGeometry, roadMaterial);
    roadMesh.receiveShadow = true;
    roadMesh.visible = false; // Hide 3D road to reduce fill-rate overhead
    trackGroup.add(roadMesh);

    // --- Build 3D White Borders/Curbs Mesh ---
    const borderPositions: number[] = [];
    const borderIndices: number[] = [];
    
    for (let i = 0; i < n; i++) {
        const prev = curvePoints[(i - 1 + n) % n];
        const next = curvePoints[(i + 1) % n];
        const tangent = next.clone().sub(prev).normalize();
        const normal = new THREE.Vector3(-tangent.z, 0, tangent.x).normalize();
        
        const leftInner = sidePoints1[i].clone();
        leftInner.y -= 0.005;
        const leftOuter = leftInner.clone().add(normal.clone().multiplyScalar(borderThickness));
        
        const rightInner = sidePoints2[i].clone();
        rightInner.y -= 0.005;
        const rightOuter = rightInner.clone().add(normal.clone().multiplyScalar(-borderThickness));
        
        borderPositions.push(leftInner.x, leftInner.y, leftInner.z);
        borderPositions.push(leftOuter.x, leftOuter.y, leftOuter.z);
        borderPositions.push(rightInner.x, rightInner.y, rightInner.z);
        borderPositions.push(rightOuter.x, rightOuter.y, rightOuter.z);
    }
    
    for (let i = 0; i < n; i++) {
        const next = (i + 1) % n;
        
        const lCurrInner = 4 * i;
        const lCurrOuter = 4 * i + 1;
        const lNextInner = 4 * next;
        const lNextOuter = 4 * next + 1;
        
        borderIndices.push(lCurrInner, lCurrOuter, lNextInner);
        borderIndices.push(lCurrOuter, lNextOuter, lNextInner);
        
        const rCurrInner = 4 * i + 2;
        const rCurrOuter = 4 * i + 3;
        const rNextInner = 4 * next + 2;
        const rNextOuter = 4 * next + 3;
        
        borderIndices.push(rCurrInner, rNextInner, rCurrOuter);
        borderIndices.push(rCurrOuter, rNextInner, rNextOuter);
    }
    
    const borderGeometry = new THREE.BufferGeometry();
    borderGeometry.setAttribute('position', new THREE.Float32BufferAttribute(borderPositions, 3));
    borderGeometry.setIndex(borderIndices);
    borderGeometry.computeVertexNormals();
    
    const borderMaterial = new THREE.MeshStandardMaterial({
        color: 0xffffff, // Clean white contrast borders
        roughness: 0.4,
        metalness: 0.1,
        side: THREE.DoubleSide
    });
    const borderMesh = new THREE.Mesh(borderGeometry, borderMaterial);
    borderMesh.castShadow = true;
    borderMesh.receiveShadow = true;
    borderMesh.visible = false; // Hide outer boundary curbs to reduce fill-rate overhead
    trackGroup.add(borderMesh);



    //!!!!!!!!!!!!!!!!!!!!! Сюди додати оптимальну траекторію !!!!!!!!!!!!!!!!!!!

 /*   const apexPoints: THREE.Vector3[] = [];
const step = 40; // Крок для вибірки точок (чим більше, тим менше точок для кривої)

for (let i = 0; i < curvePoints.length; i += step) {
    const t = i / curvePoints.length;
    const pos = curvePoints[i].clone();
    const tangent = curve.getTangentAt(t);
    const normal = new THREE.Vector3(-tangent.z, 0, tangent.x).normalize();

    // РОЗРАХУНОК КРИВИЗНИ ДЛЯ АПЕКСУ
    // Дивимось трохи вперед і назад, щоб зрозуміти, чи це поворот
    const prevT = Math.max(0, t - 0.05);
    const nextT = Math.min(1, t + 0.05);
    const v1 = curve.getPointAt(prevT);
    const v2 = curve.getPointAt(t);
    const v3 = curve.getPointAt(nextT);
    
    // Вектор відхилення від прямої
    const deviation = new THREE.Vector3().subVectors(v2.clone().multiplyScalar(2), v1.clone().add(v3));
    const curvature = deviation.length() * 100; // Коефіцієнт чутливості

    // Якщо це поворот (кривизна > порогу), зміщуємось до внутрішнього апексу
    if (curvature > 0.5) {
        // -1.5 або 1.5 залежно від напрямку нормалі
        const side = deviation.dot(normal) > 0 ? -1.5 : 1.5;
        pos.add(normal.multiplyScalar(side));
    }
    
    pos.y = 0.05; // Трохи вище за асфальт
    apexPoints.push(pos);
}

// Створюємо нову криву через ці "ідеальні" точки
const racingLineCurve = new THREE.CatmullRomCurve3(apexPoints, true);
const racingLinePoints = racingLineCurve.getSpacedPoints(500);

const optimalLine = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(racingLinePoints),
    new THREE.LineBasicMaterial({ color: 0xff0000, linewidth: 3 })
);

trackGroup.add(optimalLine);*/
//!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
    
    return { trackGroup, curve }; // Повертаємо об'єкт і математичну криву
}