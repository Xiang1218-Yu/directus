import { defineInterface } from '@directus/extensions';
import InterfaceSystemQualityRuleSelect from './system-quality-rule-select.vue';

export default defineInterface({
	id: 'system-quality-rule-select',
	name: 'Quality Rule',
	icon: 'fact_check',
	component: InterfaceSystemQualityRuleSelect,
	types: ['string'],
	options: null,
	system: true,
});
