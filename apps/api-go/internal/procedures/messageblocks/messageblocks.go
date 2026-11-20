// Package messageblocks is the part of packages/db/src/message-blocks.ts the ported procedures
// need: a stored message's blocks as every reader sees them, and a rewrite that writes the
// changed entry back into the row's own list.
//
// Blocks arrive here already opened by the Space key ring (the Prisma extension's read hook
// decrypts every element), so an entry is one decoded JSON value: an object that names its
// `kind` is a block and anything else is left alone, exactly as isStoredBlock decides.
package messageblocks

// Stored is storedMessageBlocks (message-blocks.ts:57-60): the entries that name their kind, in
// order. A value that is not a list reads as no blocks.
func Stored(blocks any) []map[string]any {
	value, ok := blocks.([]any)
	if !ok {
		return nil
	}
	kept := make([]map[string]any, 0, len(value))
	for _, entry := range value {
		if block, ok := IsBlock(entry); ok {
			kept = append(kept, block)
		}
	}
	return kept
}

// IsBlock is isStoredBlock: an object naming its kind. The kind's own fields stay as written,
// because rows from earlier releases hold kinds and fields today's MessageBlock schema rejects.
func IsBlock(entry any) (map[string]any, bool) {
	block, ok := entry.(map[string]any)
	if !ok {
		return nil, false
	}
	if _, named := block["kind"].(string); !named {
		return nil, false
	}
	return block, true
}

// Rewrite is changeMessageBlocks (message-blocks.ts:78-99): the row's own list with only the
// changed blocks replaced (`stored`, entries a read drops written back as they were), the same
// list as readers see it (`shown`), and whether anything changed. ok is false when the stored
// value is not a list: there is nothing to write.
func Rewrite(blocks any, change func(map[string]any) (map[string]any, bool)) (stored []any, shown []map[string]any, changed bool, ok bool) {
	value, isList := blocks.([]any)
	if !isList {
		return nil, nil, false, false
	}
	stored = make([]any, len(value))
	shown = make([]map[string]any, 0, len(value))
	for index, entry := range value {
		block, isBlock := IsBlock(entry)
		if !isBlock {
			stored[index] = entry
			continue
		}
		next, replaced := change(block)
		if replaced {
			changed = true
		}
		shown = append(shown, next)
		stored[index] = next
	}
	return stored, shown, changed, true
}

// JSONValue turns a list of blocks into the value a jsonb column stores.
func JSONValue(blocks []map[string]any) []any {
	value := make([]any, len(blocks))
	for index, block := range blocks {
		value[index] = block
	}
	return value
}
