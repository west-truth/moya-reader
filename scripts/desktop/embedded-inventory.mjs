import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

export async function recordProfileGuard(runtimeDir) {
  const inventoryPath = path.join(runtimeDir, 'inventory.json');
  const inventory = JSON.parse(await readFile(inventoryPath, 'utf8'));
  inventory.components = inventory.components.filter((item) => item.name !== 'profile-guard');
  inventory.components.push({
    name: 'profile-guard',
    installedBytes: (await stat(path.join(runtimeDir, 'moya-server-guard.exe'))).size,
  });
  async function bytes(directory) {
    let total = 0;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      if (filename === inventoryPath) continue;
      if (entry.isDirectory()) total += await bytes(filename);
      else if (entry.isFile()) total += (await stat(filename)).size;
    }
    return total;
  }
  inventory.totalInstalledBytes = await bytes(runtimeDir);
  inventory.sizeScope =
    'Runtime payload including profile guard; excludes this inventory, app executable and installer prerequisites';
  await writeFile(inventoryPath, JSON.stringify(inventory, null, 2));
}
