import { BoxGeometry, Group, Mesh, MeshStandardMaterial, PlaneGeometry } from "three";

/** Original, intentionally generic foldable geometry. No third-party model assets. */
export function createProceduralDuo() {
  const asset = new Group();
  const material = new MeshStandardMaterial({ color: 0x30343a, metalness: 0.55, roughness: 0.35 });
  const geometries: Array<BoxGeometry | PlaneGeometry> = [];
  for (const [name, x] of [
    ["left-half", -0.5],
    ["right-half", 0.5],
  ] as const) {
    const leaf = new Group();
    leaf.name = name;
    const body = new BoxGeometry(1, 1.42, 0.065);
    body.translate(x, 0, 0);
    geometries.push(body);
    leaf.add(new Mesh(body, material));
    const display = (name: string, rear: boolean) => {
      const geometry = new PlaneGeometry(0.96, 1.38);
      if (rear) geometry.rotateY(Math.PI);
      geometry.translate(x, 0, rear ? -0.034 : 0.034);
      geometries.push(geometry);
      const mesh = new Mesh(geometry, material);
      mesh.name = name;
      leaf.add(mesh);
    };
    display(name === "left-half" ? "inner-display-left" : "inner-display-right", false);
    if (name === "left-half") display("cover-display", true);
    asset.add(leaf);
  }
  return {
    asset,
    dispose() {
      for (const geometry of geometries) geometry.dispose();
      material.dispose();
    },
  };
}
