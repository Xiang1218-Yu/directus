import { t as plugin } from "./core-1z6RfQNO.mjs";
import fs from "node:fs";
//#region src/farm.ts
const createFarmVuePlugins = (options) => {
	return [plugin.farm(options), {
		name: "farm-load-vue-module-type",
		priority: -100,
		load: {
			filters: { resolvedPaths: [".vue"] },
			executor: (param) => {
				return {
					content: fs.readFileSync(param.resolvedPath, "utf8"),
					moduleType: "js"
				};
			}
		}
	}];
};
//#endregion
export { createFarmVuePlugins as default };
