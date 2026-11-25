package memoryroam

import (
	"fmt"
	"strings"
)

// The roamer has no shell, no tool loop, and no free-form write path. A pass
// asks the model for a JSON list of the named commands below and nothing else.
// Each command is checked by its own validator and applied by a fixed function
// that owns the write, so a model cannot compose a command that does not exist,
// run one outside the pass it was granted to, or reach a table it was not given.
// Every command a pass runs is reported by name, which is what Settings shows.

// Command names. They are part of the report contract.
const (
	CmdMemoryWrite     = "memory.write"
	CmdMemoryArchive   = "memory.archive"
	CmdInstructionsSet = "instructions.set"
	CmdSkillCreate     = "skill.create"
	CmdSkillUpdate     = "skill.update"
)

type passKind int

const (
	passBot passKind = iota
	passShared
	passSkills
)

// commandSpec is one named command: what it is called, the exact JSON shape the
// model must send, and the passes that may run it.
type commandSpec struct {
	Name    string
	Usage   string
	Summary string
	passes  []passKind
}

var commandRegistry = []commandSpec{
	{
		Name:    CmdMemoryWrite,
		Usage:   `{"name":"memory.write","path":"MEMORY.md","content":"complete new content"}`,
		Summary: "Replace one writable memory document with its complete new content.",
		passes:  []passKind{passBot, passShared},
	},
	{
		Name:    CmdMemoryArchive,
		Usage:   `{"name":"memory.archive","path":"archive/2026-11.md","content":"- [2026-11-25] concise archived summary"}`,
		Summary: "Append dated historical summaries to a cold archive file under archive/ (excluded from auto-prompt, searchable on demand).",
		passes:  []passKind{passBot, passShared},
	},
	{
		Name:    CmdInstructionsSet,
		Usage:   `{"name":"instructions.set","content":"complete new instructions"}`,
		Summary: "Replace the bot's Instructions with their complete new text.",
		passes:  []passKind{passBot},
	},
	{
		Name:    CmdSkillCreate,
		Usage:   `{"name":"skill.create","skill":"Skill name","description":"when to use it","body":"markdown steps"}`,
		Summary: "Add a new skill for a repeatable procedure that no existing skill covers.",
		passes:  []passKind{passSkills},
	},
	{
		Name:    CmdSkillUpdate,
		Usage:   `{"name":"skill.update","skill":"Existing skill name","body":"complete new markdown body"}`,
		Summary: "Upgrade one writable skill's body with a corrected or improved procedure.",
		passes:  []passKind{passSkills},
	},
}

func (spec commandSpec) allows(pass passKind) bool {
	for _, allowed := range spec.passes {
		if allowed == pass {
			return true
		}
	}
	return false
}

func lookupCommand(name string) (commandSpec, bool) {
	for _, spec := range commandRegistry {
		if spec.Name == name {
			return spec, true
		}
	}
	return commandSpec{}, false
}

// commandHelp lists the commands one pass may use, generated from the registry
// so the prompt can never offer a command the validator would refuse.
func commandHelp(pass passKind) string {
	var lines []string
	for _, spec := range commandRegistry {
		if spec.allows(pass) {
			lines = append(lines, fmt.Sprintf("- %s: %s\n  %s", spec.Name, spec.Summary, spec.Usage))
		}
	}
	return strings.Join(lines, "\n")
}

// CommandList is the registry as text, one command per block, for `--commands`.
func CommandList() string {
	passNames := map[passKind]string{passBot: "bot", passShared: "shared", passSkills: "skills"}
	var blocks []string
	for _, spec := range commandRegistry {
		var granted []string
		for _, pass := range spec.passes {
			granted = append(granted, passNames[pass])
		}
		blocks = append(blocks, fmt.Sprintf("%s  [%s pass]\n  %s\n  %s",
			spec.Name, strings.Join(granted, ", "), spec.Summary, spec.Usage))
	}
	return strings.Join(blocks, "\n\n")
}

// command is one entry of the model's answer. One struct covers every command;
// each validator reads only the fields its command defines.
type command struct {
	Name        string `json:"name"`
	Path        string `json:"path"`
	Content     string `json:"content"`
	Skill       string `json:"skill"`
	Description string `json:"description"`
	Body        string `json:"body"`
}

type answer struct {
	Commands []command `json:"commands"`
}
