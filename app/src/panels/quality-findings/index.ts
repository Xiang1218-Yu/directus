import { definePanel } from '@directus/extensions';
import PanelQualityFindings from './panel-quality-findings.vue';

export default definePanel({
	id: 'quality-findings',
	name: 'Quality Findings',
	description: 'Shows accessible affected entries from the latest completed scan of a quality rule.',
	icon: 'fact_check',
	component: PanelQualityFindings,
	options: [
		{
			field: 'rule',
			type: 'string',
			name: 'Quality rule',
			meta: {
				interface: 'system-quality-rule-select',
				width: 'full',
			},
		},
		{
			field: 'limit',
			type: 'integer',
			name: 'Limit',
			schema: {
				default_value: 10,
			},
			meta: {
				interface: 'input',
				width: 'half',
			},
		},
	],
	minWidth: 12,
	minHeight: 8,
});
