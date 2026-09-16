import { defineModule } from '@directus/extensions';
import QualityRulesOverview from './routes/overview.vue';
import QualityRuleDetail from './routes/rule.vue';

export default defineModule({
	id: 'quality-rules',
	name: 'Quality Checks',
	icon: 'fact_check',
	routes: [
		{
			name: 'quality-rules-overview',
			path: '',
			component: QualityRulesOverview,
		},
		{
			name: 'quality-rule',
			path: ':primaryKey',
			component: QualityRuleDetail,
			props: true,
		},
	],
	preRegisterCheck(user: { admin_access?: boolean }) {
		return user.admin_access === true;
	},
});
