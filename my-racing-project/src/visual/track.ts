import * as THREE from 'three';

export function createTrack(points: THREE.Vector3[]) {
    const curve = new THREE.CatmullRomCurve3(points, true);
    const curvePoints = curve.getSpacedPoints(1000);
    
    const trackGroup = new THREE.Group();

    // Центральна лінія
    const centerGeometry = new THREE.BufferGeometry().setFromPoints(curvePoints);
    const centerMaterial = new THREE.LineBasicMaterial({ 
        color: 0xf5f5f5, 
        transparent: true, 
        opacity: 0.8 
    });
    const centerLine = new THREE.Line(centerGeometry, centerMaterial);

    trackGroup.add(centerLine);

    // Пунктирні межі
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