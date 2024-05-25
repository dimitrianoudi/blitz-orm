import type {
	EnrichedAttributeQuery,
	EnrichedBQLQuery,
	EnrichedBormSchema,
	EnrichedFieldQuery,
	EnrichedLinkQuery,
	EnrichedRoleQuery,
	Filter,
	PositiveFilter,
} from '../../../types';
import { getSchemaByThing, indent } from '../../../helpers';
import { QueryPath } from '../../../types/symbols';
import { isArray } from 'radash';
import { prepareTableNameSurrealDB } from '../../../adapters/surrealDB/helpers';

export const build = (props: { queries: EnrichedBQLQuery[]; schema: EnrichedBormSchema }) => {
	const { queries, schema } = props;
	//console.log('queries!', queries);
	return queries.map((query) => buildQuery({ query, schema }));
};

const buildQuery = (props: { query: EnrichedBQLQuery; schema: EnrichedBormSchema }): string | null => {
	const { query, schema } = props;
	const { $thing, $fields, $filter, $offset, $limit } = query;

	if ($fields.length === 0) {
		return null;
	}

	const lines: string[] = [];

	lines.push('SELECT');

	const fieldLines = buildFieldsQuery({ parentQuery: query, queries: $fields, level: 1, schema });
	if (fieldLines) {
		lines.push(fieldLines);
	}

	const currentSchema = schema.entities[$thing] || schema.relations[$thing];
	if (!currentSchema) {
		throw new Error(`Schema for ${$thing} not found`);
	}
	const allTypes = currentSchema.subTypes ? [$thing, ...currentSchema.subTypes] : [$thing];
	const allTypesNormed = allTypes.map((t) => prepareTableNameSurrealDB(t));

	if (query.$id) {
		if (typeof query.$id === 'string') {
			lines.push(`FROM ${allTypesNormed.map((t) => `${t}:\`${query.$id}\``).join(',')}`);
		} else if (isArray(query.$id)) {
			const $ids = query.$id;
			const allCombinations = allTypesNormed.flatMap((t) => $ids?.map((id) => `${t}:\`${id}\``));
			lines.push(`FROM ${allCombinations.join(',')}`);
			//throw new Error('Multiple ids not supported');
		} else {
			throw new Error('Invalid $id');
		}
	} else {
		lines.push(`FROM ${allTypesNormed.join(',')}`);
	}

	const filter = ($filter && buildFilter($filter, 0)) || [];
	lines.push(...filter);

	if (typeof $limit === 'number') {
		lines.push(`LIMIT ${$limit}`);
	}

	if (typeof $offset === 'number') {
		lines.push(`START ${$offset}`);
	}

	return lines.join('\n');
};

const buildFieldsQuery = (props: {
	queries: EnrichedFieldQuery[];
	schema: EnrichedBormSchema;
	level: number;
	parentQuery: EnrichedBQLQuery | EnrichedRoleQuery | EnrichedLinkQuery;
}) => {
	const { queries, schema, level, parentQuery } = props;
	const lines: string[] = [];

	const queryPath = parentQuery[QueryPath];
	//Metadata
	lines.push(indent(`"${queryPath}" as \`$$queryPath\``, level));
	lines.push(indent('meta::id(id) as `$id`', level));
	lines.push(indent('meta::tb(id) as `$thing`', level));

	queries.forEach((i) => {
		const line = buildFieldQuery({ query: i, level, schema });
		if (line) {
			lines.push(line);
		}
	});
	if (lines.length === 0) {
		return null;
	}
	return lines.join(',\n');
};

const buildFieldQuery = (props: {
	query: EnrichedFieldQuery;
	schema: EnrichedBormSchema;
	level: number;
}): string | null => {
	const { query, schema, level } = props;

	if (query.$fieldType === 'data') {
		return buildAttributeQuery({ query, level });
	}
	if (query.$fieldType === 'link') {
		return buildLinkQuery({ query, level, schema });
	}
	if (query.$fieldType === 'role') {
		return buildRoleQuery({ query, level, schema });
	}
	return null;
};

const buildAttributeQuery = (props: { query: EnrichedAttributeQuery; level: number }): string | null => {
	const { query, level } = props;
	if (query.$isVirtual) {
		return null;
	}
	// TODO: Get the field id from the schema.
	if (query.$path === 'id') {
		return indent(`meta::id(${query.$path}) AS ${query.$as}`, level);
	}
	if (query.$path === query.$as) {
		return indent(`\`${query.$path}\``, level);
	}
	return indent(`\`${query.$path}\` AS \`${query.$as}\``, level);
};

const buildLinkQuery = (props: {
	query: EnrichedLinkQuery;
	schema: EnrichedBormSchema;
	level: number;
}): string | null => {
	const { query, schema, level } = props;
	const { $fields, $filter, $offset, $limit } = query;

	if ($fields.length === 0) {
		return null;
	}

	const lines: string[] = [];

	lines.push(indent('(', level));

	const queryLevel = level + 1;
	//console.log('query!!', query);

	lines.push(indent('SELECT', queryLevel));

	const fieldLevel = queryLevel + 1;
	const fieldLines = buildFieldsQuery({ parentQuery: query, queries: $fields, level: fieldLevel, schema });
	if (fieldLines) {
		lines.push(fieldLines);
	}

	/// FROM

	const currentSchema = getSchemaByThing(schema, query.$playedBy.thing);
	const subTypes = currentSchema?.subTypes || [];
	const things = [query.$playedBy.thing, ...subTypes];

	if (query.$target === 'relation') {
		// [Space]<-SpaceObj_spaces<-SpaceObj
		// NOTE:
		// Convention: The thing that owns the role has "out"-ward arrow
		// and the thing that has the linkField has "in"-ward arrow.
		const relationName = query.$playedBy.inheritanceOrigin ?? query.$playedBy.thing;
		const from = `<-\`${relationName}_${query.$plays}\`<-(\`${things.join('`,`')}\`)`;
		lines.push(indent(`FROM ${from}`, queryLevel));
	} else {
		// [Space]<-Space-User_spaces<-Space-User->Space-User_users->User
		const from = `<-\`${query.$playedBy.relation}_${query.$plays}\`<-\`${query.$playedBy.relation}\`->\`${query.$playedBy.relation}_${query.$playedBy.plays}\`->(\`${things.join('`,`')}\`)`;
		lines.push(indent(`FROM ${from}`, queryLevel));
	}

	/// FILTER WHERE
	if ($filter || query.$id) {
		const $ids = !query.$id ? null : isArray(query.$id) ? query.$id : [query.$id];
		///Using it only in roleQuery and linkQuery as the rootOne is done with the table names
		const $WithIdFilter = {
			...query.$filter,
			...($ids ? { ['meta::id(id)']: `INSIDE [${$ids.map((id) => `"${id}"`).join(', ')}] ` } : {}),
		};
		lines.push(...buildFilter($WithIdFilter, queryLevel));
	}

	/// SORT AND PAGINATION
	if (typeof $limit === 'number') {
		lines.push(indent(`LIMIT ${$limit}`, queryLevel));
	}

	if (typeof $offset === 'number') {
		lines.push(indent(`START ${$offset}`, queryLevel));
	}

	lines.push(indent(`) AS \`${query.$as}\``, level));

	return lines.join('\n');
};

const buildRoleQuery = (props: {
	query: EnrichedRoleQuery;
	schema: EnrichedBormSchema;
	level: number;
}): string | null => {
	const { query, schema, level } = props;

	if (query.$fields.length === 0) {
		return null;
	}

	const lines: string[] = [];

	lines.push(indent('(', level));

	const queryLevel = level + 1;
	lines.push(indent('SELECT', queryLevel));

	const fieldLevel = queryLevel + 1;
	const fieldLines = buildFieldsQuery({ parentQuery: query, queries: query.$fields, level: fieldLevel, schema });
	if (fieldLines) {
		lines.push(fieldLines);
	}

	const currentSchema = getSchemaByThing(schema, query.$playedBy.thing);
	const subTypes = currentSchema?.subTypes || [];
	const things = [query.$playedBy.thing, ...subTypes];

	const from = `->\`${query.$playedBy.relation}_${query.$playedBy.plays}\`->(\`${things.join('`,`')}\`)`;
	lines.push(indent(`FROM ${from}`, queryLevel));

	if (query.$filter || query.$id) {
		const $ids = !query.$id ? null : isArray(query.$id) ? query.$id : [query.$id];
		///Using it only in roleQuery and linkQuery as the rootOne is done with the table names
		const $WithIdFilter = {
			...query.$filter,
			...($ids ? { ['meta::id(id)']: `INSIDE [${$ids.map((id) => `"${id}"`).join(', ')}] ` } : {}),
		};
		lines.push(...buildFilter($WithIdFilter, queryLevel));
	}

	lines.push(indent(`) AS \`${query.$as}\``, level));

	return lines.join('\n');
};

const buildFilter = (filter: Filter, level: number): string[] => {
	const conditions: string[] = [];
	const { $not, ...f } = filter;
	const conditionLevel = level + 1;
	Object.entries(f).forEach(([key, value]) => {
		//id is a reserved one, this is not right all the time tho...
		if (key === 'id') {
			conditions.push(indent(`meta::id(id)=${JSON.stringify(value)}`, conditionLevel));
		} else if (key === 'meta::id(id)') {
			//todo: special filter stuff, like IN, INCLUDED etc
			conditions.push(indent(`${key} ${value}`, conditionLevel));
		} else {
			conditions.push(indent(`\`${key}\`=${JSON.stringify(value)}`, conditionLevel));
		}
	});
	if ($not) {
		Object.entries($not as PositiveFilter).forEach(([key, value]) => {
			conditions.push(`${key}!=${JSON.stringify(value)}`);
		});
	}
	const [firstCondition, ...restConditions] = conditions;
	if (firstCondition) {
		return [
			indent('WHERE (', level),
			indent(firstCondition, conditionLevel),
			...restConditions.map((i) => indent(`AND ${i}`, conditionLevel)),
			indent(')', level),
		];
	}
	return conditions;
};
