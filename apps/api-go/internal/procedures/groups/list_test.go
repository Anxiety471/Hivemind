package groups

import "testing"

func TestPrimaryActiveRun(t *testing.T) {
	cases := []struct {
		statuses []string
		want     string
	}{
		{[]string{"queued"}, "queued"},
		{[]string{"queued", "running"}, "running"},
		{[]string{"leased", "queued"}, "leased"},
		{[]string{"running", "waiting_input"}, "waiting_input"},
		{[]string{"waiting_input", "waiting_takeover"}, "waiting_takeover"},
	}
	for _, item := range cases {
		if got := primaryActiveRun(item.statuses); got != item.want {
			t.Errorf("primaryActiveRun(%v) = %q, want %q", item.statuses, got, item.want)
		}
	}
}

func TestValidateGroup(t *testing.T) {
	valid := func() Group {
		return Group{
			ID: "g", SpaceID: "s", ThreadID: "t",
			Members: []GroupMember{{BotID: "b", AvatarSet: "organic"}},
		}
	}
	if failure := validateGroup(valid()); failure != nil {
		t.Fatalf("valid group = %v", failure)
	}
	for name, mutate := range map[string]func(*Group){
		"empty id":       func(group *Group) { group.ID = "" },
		"empty thread":   func(group *Group) { group.ThreadID = "" },
		"empty section":  func(group *Group) { empty := ""; group.SectionID = &empty },
		"empty member":   func(group *Group) { group.Members[0].BotID = "" },
		"bad avatar set": func(group *Group) { group.Members[0].AvatarSet = "x" },
	} {
		group := valid()
		mutate(&group)
		failure := validateGroup(group)
		if failure == nil || failure.Message != "Output validation failed" {
			t.Errorf("%s: validateGroup = %v", name, failure)
		}
	}
}
