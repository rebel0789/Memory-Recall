import { readFile } from 'node:fs/promises';
const status=JSON.parse(await readFile('PROJECT_STATUS.json','utf8'));
console.log(`${status.project} ${status.release} — ${status.phase}`);console.log(`Next task: ${status.nextTask}`);console.log(`Defaults: network=${status.defaults.network}, externalWrites=${status.defaults.externalWrites}, model=${status.defaults.modelMode}, residency=${status.defaults.dataResidency}`);
const groups=Map.groupBy(status.capabilities,item=>item.status);
for(const state of ['implemented','reference','experimental','specified','disabled','unsupported']){const items=groups.get(state)??[];if(!items.length)continue;console.log(`\n${state.toUpperCase()} (${items.length})`);for(const item of items)console.log(`- ${item.id}: ${item.name}`)}
