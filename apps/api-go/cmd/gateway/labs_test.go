package main

import (
	"reflect"
	"testing"
)

func TestDeploymentLabs(t *testing.T) {
	cases := []struct {
		name                   string
		board, code, codeFirst bool
		want                   []string
	}{
		{"none", false, false, false, []string{}},
		{"board", true, false, false, []string{"board"}},
		{"code mode and code first", false, true, true, []string{"code", "codeFirst"}},
		{"all in the order of the contract", true, true, true, []string{"board", "code", "codeFirst"}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := deploymentLabs(c.board, c.code, c.codeFirst); !reflect.DeepEqual(got, c.want) {
				t.Fatalf("deploymentLabs = %v, want %v", got, c.want)
			}
		})
	}
}
