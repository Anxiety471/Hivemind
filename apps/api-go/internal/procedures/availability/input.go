package availability

import (
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/orpc"
	"github.com/Anxiety471/Hivemind/apps/api-go/internal/validate"
)

var kinds = []string{kindSkill, kindMcpServer, kindInstall}

// ParseSet mirrors
//
//	z.object({ kind: AvailabilityKindSchema, id: Id }).and(
//	  z.object({ allSpaces: z.boolean(), spaceIds: z.array(Id).min(1) }))
//
// An intersection reports its left side's issues, then its right side's, each side
// parsing the whole input.
func ParseSet(raw orpc.Input) (SetInput, *orpc.Error) {
	var input SetInput
	object, issues := validate.Decode(raw.Raw, nil)
	if issues != nil {
		return input, validate.Fail(append(append([]validate.Issue{}, issues...), issues...))
	}
	var found []validate.Issue
	kind, problems := validate.Enum(validate.Path{"kind"}, object.Field("kind"), kinds...)
	found = append(found, problems...)
	id, problems := validate.String(validate.Path{"id"}, object.Field("id"), validate.StringRules{Min: 1})
	found = append(found, problems...)
	allSpaces, problems := validate.Boolean(validate.Path{"allSpaces"}, object.Field("allSpaces"))
	found = append(found, problems...)
	spaceIDs, problems := parseSpaceIDs(object.Field("spaceIds"))
	found = append(found, problems...)
	if found != nil {
		return input, validate.Fail(found)
	}
	return SetInput{Kind: kind, ID: id, AllSpaces: &allSpaces, SpaceIDs: &spaceIDs}, nil
}

// parseSpaceIDs is z.array(Id).min(1).
func parseSpaceIDs(raw any) ([]string, []validate.Issue) {
	path := validate.Path{"spaceIds"}
	items, problems := validate.AsArray(path, raw)
	if problems != nil {
		return nil, problems
	}
	var found []validate.Issue
	ids := make([]string, 0, len(items))
	for index, item := range items {
		id, problems := validate.String(path.With(index), item, validate.StringRules{Min: 1})
		found = append(found, problems...)
		ids = append(ids, id)
	}
	found = append(found, validate.ArrayBounds(path, len(items), 1, 0)...)
	if found != nil {
		return nil, found
	}
	return ids, nil
}

// ParseChoose mirrors
//
//	z.object({ spaceId: Id, items: z.array(z.object({ kind, id: Id })).max(500) }).
func ParseChoose(raw orpc.Input) (ChooseInput, *orpc.Error) {
	var input ChooseInput
	object, issues := validate.Decode(raw.Raw, nil)
	if issues != nil {
		return input, validate.Fail(issues)
	}
	var found []validate.Issue
	spaceID, problems := validate.String(validate.Path{"spaceId"}, object.Field("spaceId"), validate.StringRules{Min: 1})
	found = append(found, problems...)
	path := validate.Path{"items"}
	items, problems := validate.AsArray(path, object.Field("items"))
	found = append(found, problems...)
	var parsed []ChooseItem
	if problems == nil && len(items) > 500 {
		// Zod checks the length before the items, and an over-long array reports nothing else.
		found = append(found, validate.ArrayBounds(path, len(items), 0, 500)...)
	} else if problems == nil {
		for index, item := range items {
			itemPath := path.With(index)
			entry, problems := validate.AsObject(item, itemPath)
			if problems != nil {
				found = append(found, problems...)
				continue
			}
			kind, problems := validate.Enum(itemPath.With("kind"), entry.Field("kind"), kinds...)
			found = append(found, problems...)
			id, problems := validate.String(itemPath.With("id"), entry.Field("id"), validate.StringRules{Min: 1})
			found = append(found, problems...)
			parsed = append(parsed, ChooseItem{Kind: kind, ID: id})
		}
	}
	if found != nil {
		return input, validate.Fail(found)
	}
	return ChooseInput{SpaceID: spaceID, Items: parsed}, nil
}
