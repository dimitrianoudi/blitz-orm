import type { PipelineOperation } from '../pipeline';

const separator = '___';

export const newBuildTQLQuery: PipelineOperation = async (req) => {
	const { enrichedBqlQuery } = req;
	if (!enrichedBqlQuery) {
		throw new Error('BQL query not enriched');
	}

	let tqlStr = '';

	type ValueBlock = {
		$thing: string;
		$thingType: 'entity' | 'relation' | 'thing' | 'attribute';
		$path?: string;
		$as?: string;
		$var?: string;
		$fields?: ValueBlock[];
		$filter?: object;
		$fieldType?: 'data' | 'role' | 'link';
	};

	const processFilters = ($filter: object) => {
		for (const key in $filter) {
			// @ts-expect-error todo
			tqlStr += `, has ${key} "${$filter[key]}"`;
		}
		tqlStr += '; \n';
	};

	const processDataFields = (
		dataFields: {
			$path: string;
			$thingType: 'attribute';
			$as: string;
			$var: string;
			$fieldType: 'data';
			$justId: boolean;
		}[],
		$path: string,
	) => {
		// let justId = false;
		let postStr = '';
		let $asMetaData = '';
		for (let i = 0; i < dataFields.length; i++) {
			postStr += ` ${dataFields[i].$path}`;
			$asMetaData += `{${dataFields[i].$var}:${dataFields[i].$as}}`;
			if (i < dataFields.length - 1) {
				postStr += ',';
				$asMetaData += ',';
			} else {
				postStr += ';\n';
			}
			// if (dataFields[i].$justId) {
			// 	justId = true;
			// }
		}
		const $metaData = `$metadata:{as:[${$asMetaData}]}`;

		tqlStr += `$${$path} as "${$path}.${$metaData}.dataFields": `;
		tqlStr += postStr;
	};

	const processRoleFields = (
		roleFields: {
			$path: string;
			$thingType: 'entity' | 'relation' | 'thing';
			$as: string;
			$var: string;
			$fieldType: 'link';
			$target: 'role' | 'relation';
			$fields?: ValueBlock[];
			$thing: string;
			$plays: string;
			$intermediary: string;
			$justId: boolean;
		}[],
		$path: string,
		dotPath: string,
	) => {
		for (const roleField of roleFields) {
			const { $fields, $as, $justId } = roleField;
			const $metaData = `$metadata:{as:${$as},justId:${$justId ? 'T' : 'F'}}`;
			tqlStr += `"${dotPath}.${$metaData}.${roleField.$var}":{ \n`;
			tqlStr += '\tmatch \n';
			tqlStr += `\t$${$path} (${roleField.$var}: $${$path}${separator}${roleField.$var}) isa ${roleField.$intermediary}; \n`;

			if ($fields) {
				tqlStr += '\tfetch \n';
			}
			const dataFields = $fields?.filter((f) => f.$fieldType === 'data');
			if (dataFields && dataFields.length > 0) {
				// @ts-expect-error todo
				processDataFields(dataFields, `${$path}${separator}${roleField.$var}`, `${$path}.${roleField.$var}`);
			}

			const linkFields = $fields?.filter((f) => f.$fieldType === 'link');
			if (linkFields && linkFields.length > 0) {
				// @ts-expect-error todo
				processLinkFields(linkFields, `${$path}${separator}${roleField.$var}`, `${$path}.${roleField.$var}`);
			}
			const roleFields = $fields?.filter((f) => f.$fieldType === 'role');
			if (roleFields && roleFields.length > 0) {
				// @ts-expect-error todo
				processRoleFields(roleFields, `${$path}${separator}${roleField.$var}`, `${$path}.${roleField.$var}`);
			}
			tqlStr += '}; \n';
		}
	};

	const processLinkFields = (
		linkFields: {
			$path: string;
			$thingType: 'entity' | 'relation' | 'thing';
			$as: string;
			$var: string;
			$fieldType: 'link';
			$target: 'role' | 'relation';
			$fields?: ValueBlock[];
			$intermediary?: string;
			$thing: string;
			$plays: string;
			$justId: boolean;
		}[],
		$path: string,
		dotPath: string,
	) => {
		for (const linkField of linkFields) {
			const { $fields, $as, $justId } = linkField;
			const $metaData = `$metadata:{as:${$as},justId:${$justId ? 'T' : 'F'}}`;
			tqlStr += `"${dotPath}.${$metaData}.${linkField.$var}":{ \n`;
			tqlStr += '\tmatch \n';
			// a. intermediary
			if (linkField.$target === 'role') {
				tqlStr += `\t$${$path}_intermediary (${linkField.$path}: $${$path}, ${linkField.$var}: $${$path}${separator}${linkField.$var}) isa ${linkField.$intermediary}; \n`;
			} else {
				// b. no intermediary
				tqlStr += `\t$${$path}${separator}${linkField.$var} (${linkField.$plays}: $${$path}) isa ${linkField.$thing}; \n`;
			}
			if ($fields) {
				tqlStr += '\tfetch \n';
			}
			const dataFields = $fields?.filter((f) => f.$fieldType === 'data');
			if (dataFields && dataFields.length > 0) {
				// @ts-expect-error todo
				processDataFields(dataFields, `${$path}${separator}${linkField.$var}`);
			}

			const linkFields = $fields?.filter((f) => f.$fieldType === 'link');
			if (linkFields && linkFields.length > 0) {
				// @ts-expect-error todo
				processLinkFields(linkFields, `${$path}${separator}${linkField.$var}`, `${$path}.${linkField.$var}`);
			}

			const roleFields = $fields?.filter((f) => f.$fieldType === 'role');
			if (roleFields && roleFields.length > 0) {
				// @ts-expect-error todo
				processRoleFields(roleFields, `${$path}${separator}${linkField.$var}`, `${$path}.${linkField.$var}`);
			}
			tqlStr += '}; \n';
		}
	};

	const builder = (enrichedBqlQuery: ValueBlock[]) => {
		for (const query of enrichedBqlQuery) {
			const { $path, $thing, $filter, $fields } = query;
			tqlStr += `match \n \t $${$path} isa ${$thing} `;
			if ($filter) {
				processFilters($filter);
			} else {
				tqlStr += '; ';
			}
			if ($fields) {
				tqlStr += 'fetch \n';
			}
			const dataFields = $fields?.filter((f) => f.$fieldType === 'data');
			if (dataFields && dataFields.length > 0) {
				// @ts-expect-error todo
				processDataFields(dataFields, $path);
			}

			const linkFields = $fields?.filter((f) => f.$fieldType === 'link');
			if (linkFields && linkFields.length > 0) {
				// @ts-expect-error todo
				processLinkFields(linkFields, $path, $path);
			}

			const roleFields = $fields?.filter((f) => f.$fieldType === 'role');
			if (roleFields && roleFields.length > 0) {
				// @ts-expect-error todo
				processRoleFields(roleFields, $path, $path);
			}
		}
	};
	builder(enrichedBqlQuery);
	// console.log('enriched: ', JSON.stringify(enrichedBqlQuery, null, 2));
	// console.log(tqlStr);

	// todo: type the tqlRequest
	// @ts-expect-error todo
	req.tqlRequest = tqlStr;
};
