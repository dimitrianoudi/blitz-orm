import type {
	BQLMutation,
	BQLMutationBlock,
	BormConfig,
	DBHandles,
	EnrichedBQLMutationBlock,
	EnrichedBormSchema,
} from '../../types';
import { enrichBQLMutation } from './bql/enrich';
import { parseBQLMutation } from './bql/parse';
import { mutationPreQuery } from './bql/preQuery';

import { createMachine, transition, reduce, guard, interpret, state, invoke } from '../robot3';
import { stringify } from './bql/stringify';
import { preHookDependencies } from './bql/enrichSteps/preHookDependencies';
import { dependenciesGuard } from './bql/guards/dependenciesGuard';
import { runTypeDbMutationMachine } from './tql/machine';
import { runSurrealDbMutationMachine } from './surql/machine';

const final = state;

export type bqlMutationContext = {
	raw: BQLMutationBlock | BQLMutationBlock[];
	enriched: EnrichedBQLMutationBlock | EnrichedBQLMutationBlock[];
	things: any[];
	edges: any[];
	res: any[];
};

type MachineContext = {
	bql: bqlMutationContext;
	schema: EnrichedBormSchema;
	config: BormConfig;
	handles: DBHandles;
	depthLevel: number;
	error: string | null;
};

// Reducer
// ============================================================================

const updateBqlReq = (ctx: MachineContext, event: any) => {
	if (!event.data) {
		///when preQueries return nothing, that should not affect the ctx
		return ctx;
	}
	return {
		...ctx,
		bql: { ...ctx.bql, enriched: event.data },
	};
};

const updateThingsEdges = (ctx: MachineContext, event: any) => {
	return {
		...ctx,
		bql: {
			...ctx.bql,
			things: event.data.mergedThings,
			edges: event.data.mergedEdges,
		},
	};
};

const updateBQLRes = (ctx: MachineContext, event: any) => {
	return {
		...ctx,
		bql: {
			...ctx.bql,
			res: event.data,
		},
	};
};

// Actors
// ============================================================================

const enrich = async (ctx: MachineContext) => {
	const enriched = Object.keys(ctx.bql.enriched).length
		? enrichBQLMutation(ctx.bql.enriched, ctx.schema, ctx.config)
		: enrichBQLMutation(ctx.bql.raw, ctx.schema, ctx.config);
	//console.log('enriched', enriched);
	return enriched;
};

const preQuery = async (ctx: MachineContext) => {
	return mutationPreQuery(ctx.bql.enriched, ctx.schema, ctx.config, ctx.handles);
};

const preQueryDependencies = async (ctx: MachineContext) => {
	return preHookDependencies(ctx.bql.enriched, ctx.schema, ctx.config, ctx.handles);
};

const parseBQL = async (ctx: MachineContext) => {
	return parseBQLMutation(ctx.bql.enriched, ctx.schema);
};

// Guards
// ============================================================================
const requiresPreQuery = (ctx: MachineContext) => {
	const { dbConnectors } = ctx.config;
	if (dbConnectors.length !== 1) {
		throw new Error('Multiple providers not supported yet in mutations');
	}
	const [{ provider }] = dbConnectors;

	if (provider === 'typeDB') {
		return true;
	}
	if (provider === 'surrealDB') {
		return false;
	}
	throw new Error(`Unsupported provider ${provider}.`);
};

const requiresPreHookDependencies = (ctx: MachineContext) => {
	return dependenciesGuard(ctx.bql.enriched);
};

// Transitions
// ============================================================================

const errorTransition = transition(
	'error',
	'error',
	reduce((ctx: MachineContext, event: any) => {
		return {
			...ctx,
			error: event.error,
		};
	}),
);

export const machine = createMachine(
	'stringify',
	{
		stringify: invoke(
			async (ctx: MachineContext) => stringify(ctx.bql.raw, ctx.schema),
			transition('done', 'enrich', reduce(updateBqlReq)),
			errorTransition,
		),
		enrich: invoke(
			enrich,
			transition('done', 'preQuery', guard(requiresPreQuery), reduce(updateBqlReq)),
			transition('done', 'parseBQL', reduce(updateBqlReq)),
			errorTransition,
		),
		preHookDependencies: invoke(
			preQueryDependencies,
			transition('done', 'enrich', reduce(updateBqlReq)),
			errorTransition,
		),
		preQuery: invoke(
			preQuery,
			transition('done', 'preHookDependencies', guard(requiresPreHookDependencies), reduce(updateBqlReq)),
			transition('done', 'parseBQL', reduce(updateBqlReq)),
			errorTransition,
		),
		parseBQL: invoke(parseBQL, transition('done', 'adapter', reduce(updateThingsEdges)), errorTransition),
		adapter: invoke(
			async (ctx: MachineContext) => {
				//todo: do this properly with multiple providers
				const { dbConnectors } = ctx.config;
				if (dbConnectors.length !== 1) {
					throw new Error('Multiple providers not supported yet in mutations');
				}
				const [{ provider }] = dbConnectors;

				if (provider === 'typeDB') {
					return runTypeDbMutationMachine(
						ctx.bql.raw,
						ctx.bql.enriched,
						ctx.bql.things,
						ctx.bql.edges,
						ctx.schema,
						ctx.config,
						ctx.handles,
					);
				}
				if (provider === 'surrealDB') {
					return runSurrealDbMutationMachine(ctx.bql.raw, ctx.bql.enriched, ctx.schema, ctx.config, ctx.handles);
				}
				throw new Error(`Unsupported provider ${provider}.`);
			},
			transition('done', 'success', reduce(updateBQLRes)),
			errorTransition,
		),
		success: final(),
		error: final(),
	},
	(ctx: MachineContext) => ctx,
);

export const awaitMachine = async (context: MachineContext) => {
	return new Promise<MachineContext>((resolve, reject) => {
		interpret(
			machine,
			(service) => {
				if (service.machine.state.name === 'success') {
					resolve(service.context);
				}
				if (service.machine.state.name === 'error') {
					reject(service.context);
				}
			},
			context,
		);
	});
};

export const runMutationMachine = async (
	mutation: BQLMutation,
	schema: EnrichedBormSchema,
	config: BormConfig,
	handles: DBHandles,
) => {
	return awaitMachine({
		bql: {
			raw: mutation,
			enriched: {} as EnrichedBQLMutationBlock | EnrichedBQLMutationBlock[],
			things: [],
			edges: [],
			res: [],
		},
		schema: schema as EnrichedBormSchema,
		config: config,
		handles: handles,
		depthLevel: 0,
		error: null,
	});
};
