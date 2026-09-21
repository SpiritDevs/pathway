import {
  BoxGeometry,
  CircleGeometry,
  CylinderGeometry,
  ExtrudeGeometry,
  Group,
  Mesh,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  Shape,
  ShapeGeometry,
  type BufferGeometry,
  type Material,
} from "three";

/** A rounded profile with independently rounded hinge and outer edges. */
function profile(
  left: number,
  right: number,
  bottom: number,
  top: number,
  leftRadius: number,
  rightRadius: number,
) {
  const shape = new Shape();
  shape.moveTo(left + leftRadius, bottom);
  shape.lineTo(right - rightRadius, bottom);
  shape.quadraticCurveTo(right, bottom, right, bottom + rightRadius);
  shape.lineTo(right, top - rightRadius);
  shape.quadraticCurveTo(right, top, right - rightRadius, top);
  shape.lineTo(left + leftRadius, top);
  shape.quadraticCurveTo(left, top, left, top - leftRadius);
  shape.lineTo(left, bottom + leftRadius);
  shape.quadraticCurveTo(left, bottom, left + leftRadius, bottom);
  return shape;
}

/** Original articulated hardware: a continuous inner display, inset glass and a beveled metal enclosure. */
export function createProceduralDuo() {
  const asset = new Group();
  const metal = new MeshStandardMaterial({ color: 0x969a9e, metalness: 0.92, roughness: 0.24 });
  const edge = new MeshStandardMaterial({ color: 0x5d6064, metalness: 0.85, roughness: 0.3 });
  const glass = new MeshPhysicalMaterial({
    color: 0x08090b,
    roughness: 0.23,
    metalness: 0.12,
    clearcoat: 0.7,
  });
  const back = new MeshStandardMaterial({ color: 0xc5c4bd, metalness: 0.25, roughness: 0.38 });
  const dark = new MeshStandardMaterial({ color: 0x14161a, roughness: 0.65 });
  const lens = new MeshPhysicalMaterial({
    color: 0x07121e,
    metalness: 0.4,
    roughness: 0.1,
    clearcoat: 1,
  });
  const materials = [metal, edge, glass, back, dark, lens];
  const geometries: BufferGeometry[] = [];
  const add = (group: Group, geometry: BufferGeometry, material: Material, name: string) => {
    geometries.push(geometry);
    const mesh = new Mesh(geometry, material);
    mesh.name = name;
    group.add(mesh);
    return mesh;
  };
  // The hinge sits in the display plane, so closing brings the glass together without intersecting the chassis.
  for (const side of [-1, 1] as const) {
    const leaf = new Group();
    leaf.name = side === -1 ? "left-half" : "right-half";
    const left = side === -1 ? -1.04 : 0;
    const right = side === -1 ? 0 : 1.04;
    const shape = (inset: number, outerRadius: number, seam = 0) =>
      profile(
        side === -1 ? left + inset : seam,
        side === -1 ? -seam : right - inset,
        -0.747 + inset,
        0.747 - inset,
        side === -1 ? outerRadius : 0.004,
        side === -1 ? 0.004 : outerRadius,
      );
    const body = new ExtrudeGeometry(shape(0.006, 0.125, 0.002), {
      depth: 0.049,
      bevelEnabled: true,
      bevelThickness: 0.003,
      bevelSize: 0.003,
      bevelSegments: 3,
      curveSegments: 16,
      steps: 1,
    });
    body.translate(0, 0, -0.054);
    add(leaf, body, metal, "enclosure");
    const rim = new ShapeGeometry(shape(0.006, 0.124, 0.001), 16);
    rim.translate(0, 0, -0.001);
    add(leaf, rim, edge, "display-rim");
    const bezel = new ShapeGeometry(shape(0.014, 0.116, 0.0005), 16);
    add(leaf, bezel, glass, side === -1 ? "inner-bezel-left" : "inner-bezel-right");
    // Only a hairline remains at the fold; each leaf shows exactly half of the native framebuffer.
    const display = new ShapeGeometry(shape(0.036, 0.096, 0.0007), 24);
    display.translate(0, 0, 0.001);
    add(leaf, display, glass, side === -1 ? "inner-display-left" : "inner-display-right");
    const rear = new ShapeGeometry(shape(0.012, 0.12, 0.003), 16);
    rear.rotateY(Math.PI);
    rear.translate(side * 1.04, 0, -0.058);
    add(leaf, rear, back, "rear-panel");
    if (side === -1) {
      const coverShape = profile(-1.002, -0.038, -0.704, 0.704, 0.09, 0.09);
      const coverBezel = new ShapeGeometry(
        profile(-1.025, -0.015, -0.728, 0.728, 0.112, 0.112),
        20,
      );
      const cover = new ShapeGeometry(coverShape, 24);
      for (const [geometry, name] of [
        [coverBezel, "cover-bezel"],
        [cover, "cover-display"],
      ] as const) {
        geometry.rotateY(Math.PI);
        geometry.translate(-1.04, 0, name === "cover-display" ? -0.06 : -0.059);
        add(leaf, geometry, glass, name);
      }
    } else {
      const plate = new ExtrudeGeometry(profile(0.7, 0.98, 0.18, 0.62, 0.065, 0.065), {
        depth: 0.015,
        bevelEnabled: true,
        bevelSize: 0.007,
        bevelThickness: 0.004,
        bevelSegments: 3,
        curveSegments: 12,
      });
      plate.rotateY(Math.PI);
      plate.translate(1.04, 0, -0.059);
      add(leaf, plate, back, "camera-island");
      for (const y of [0.31, 0.49]) {
        const ring = new CylinderGeometry(0.066, 0.066, 0.016, 32);
        ring.rotateX(Math.PI / 2);
        ring.translate(0.2, y, -0.086);
        add(leaf, ring, edge, "camera-ring");
        const front = new CircleGeometry(0.052, 32);
        front.rotateY(Math.PI);
        front.translate(0.2, y, -0.095);
        add(leaf, front, lens, "camera-lens");
      }
      for (const [y, height] of [
        [0.35, 0.18],
        [0.08, 0.12],
      ] as const) {
        const button = new BoxGeometry(0.011, height, 0.024);
        button.translate(1.046, y, -0.03);
        add(leaf, button, metal, "side-button");
      }
    }
    for (const y of [-0.713, 0.713]) {
      const hinge = new CylinderGeometry(0.024, 0.024, 0.036, 16);
      hinge.translate(side * 0.022, y, -0.026);
      add(leaf, hinge, edge, "hinge-cap");
    }
    for (const y of [-0.55, 0.55]) {
      const antenna = new BoxGeometry(0.004, 0.008, 0.046);
      antenna.translate(side * 1.043, y, -0.03);
      add(leaf, antenna, dark, "antenna-break");
    }
    asset.add(leaf);
  }
  return {
    asset,
    dispose() {
      for (const geometry of geometries) geometry.dispose();
      for (const material of materials) material.dispose();
    },
  };
}
