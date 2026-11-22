package modelcredentials

import (
	"os"
	"strings"
)

// catalogModel is one row of the generated listPiCatalog metadata.
type catalogModel struct {
	Provider string
	ID       string
	Images   bool
	// Levels is the model's getSupportedThinkingLevels list, comma separated. Empty means off only.
	Levels string
}

// CatalogModel is one model the catalog offers, as validation needs it.
type CatalogModel struct {
	Provider string
	ID       string
	Images   bool
	// ThinkingLevels is nil for a model outside the catalog. A model in it without reasoning
	// accepts only "off".
	ThinkingLevels []string
}

var catalogIndex = func() map[string]CatalogModel {
	index := make(map[string]CatalogModel, len(catalogModels))
	for _, model := range catalogModels {
		key := model.Provider + "\x00" + model.ID
		thinking := []string{"off"}
		if model.Levels != "" {
			thinking = strings.Split(model.Levels, ",")
		}
		index[key] = CatalogModel{
			Provider:       model.Provider,
			ID:             model.ID,
			Images:         model.Images,
			ThinkingLevels: thinking,
		}
	}
	return index
}()

// CatalogEntry is listPiCatalog's entry for a provider and model. The caller canonicalizes the
// provider first, as canonicalPiProviderId does.
func CatalogEntry(provider, modelID string) (CatalogModel, bool) {
	model, ok := catalogIndex[provider+"\x00"+modelID]
	return model, ok
}

// DeclaredModel is isCatalogModelChoice without the live provider lists: the pinned
// catalog, the scripted fixture, and the local server's operator-declared models.
func DeclaredModel(provider, modelID string) (CatalogModel, bool) {
	if model, ok := CatalogEntry(provider, modelID); ok {
		return model, true
	}
	if provider == "scripted" && modelID == "scripted" {
		return CatalogModel{Provider: provider, ID: modelID, ThinkingLevels: []string{"off"}}, true
	}
	if provider == "local" && contains(localModelIDs(), modelID) {
		level := []string{"off"}
		if contains(localReasoningModelIDs(), modelID) {
			level = thinkingLevels
		}
		return CatalogModel{
			Provider:       provider,
			ID:             modelID,
			Images:         contains(localVisionModelIDs(), modelID),
			ThinkingLevels: level,
		}, true
	}
	return CatalogModel{}, false
}

// localModelIDs is localModelIds (RAKAZO_LOCAL_MODELS).
func localModelIDs() []string {
	return splitIDs(os.Getenv("RAKAZO_LOCAL_MODELS"))
}

// localVisionModelIDs is localVisionModelIds (RAKAZO_LOCAL_VISION_MODELS).
func localVisionModelIDs() []string {
	return splitIDs(os.Getenv("RAKAZO_LOCAL_VISION_MODELS"))
}

// localReasoningModelIDs is the local server's thinking opt-in (RAKAZO_LOCAL_REASONING_MODELS).
func localReasoningModelIDs() []string {
	return splitIDs(os.Getenv("RAKAZO_LOCAL_REASONING_MODELS"))
}

func splitIDs(value string) []string {
	ids := []string{}
	for _, id := range strings.Split(value, ",") {
		if trimmed := trimJS(id); trimmed != "" {
			ids = append(ids, trimmed)
		}
	}
	return ids
}
