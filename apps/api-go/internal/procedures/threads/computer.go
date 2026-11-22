package threads

import (
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"math/big"
	"time"

	"github.com/jackc/pgx/v5"
)

// This file is computer-status.ts (apps/api/src/computers/computer-status.ts): the bot's computer
// as threads.get shows it. What it reads from @rakazo/adapters is declarative data, not a call:
// each computer kind's capabilities (packages/adapters/src/providers/computer/*/), the disk
// warning threshold and the disk percentage. The capabilities are copied to computer_kinds.json,
// and apps/api/src/computers/computer-kinds-table.test.ts fails when the two drift.

//go:embed computer_kinds.json
var computerKindsJSON []byte

type kindCapabilities struct {
	Terminal          bool `json:"terminal"`
	InPlaceUpdate     bool `json:"inPlaceUpdate"`
	RunsOnUserMachine bool `json:"runsOnUserMachine"`
	Width             int  `json:"width"`
	Height            int  `json:"height"`
}

var kindTable = func() struct {
	Undeclared kindCapabilities            `json:"undeclared"`
	Kinds      map[string]kindCapabilities `json:"kinds"`
} {
	var table struct {
		Undeclared kindCapabilities            `json:"undeclared"`
		Kinds      map[string]kindCapabilities `json:"kinds"`
	}
	if err := json.Unmarshal(computerKindsJSON, &table); err != nil {
		panic(err)
	}
	return table
}()

// sandboxKindCapabilities reads a computer's own kind; a kind no provider declares reads as a plain
// remote Linux computer.
func sandboxKindCapabilities(kind string) kindCapabilities {
	if capabilities, ok := kindTable.Kinds[kind]; ok {
		return capabilities
	}
	return kindTable.Undeclared
}

// diskWarningPercent is DISK_WARNING_PERCENT.
const diskWarningPercent = 90

type computerRow struct {
	ID                   string
	Kind                 string
	State                string
	Scope                string
	ControlHolder        string
	ControlBotID         *string
	HomeRevision         string
	MaintenanceID        *string
	DiskUsedBytes        *int64
	DiskFreeBytes        *int64
	DiskDismissedPercent *int32
	ControlUserID        *string
	ControlLeaseID       *string
	UserID               *string
}

const computerColumns = `id, kind, state, scope, "controlHolder", "controlBotId", "homeRevision", "maintenanceId",
	"diskUsedBytes", "diskFreeBytes", "diskDismissedPercent", "controlUserId", "controlLeaseId", "userId"`

func loadComputer(ctx context.Context, tx pgx.Tx, computerID string) (*computerRow, error) {
	var row computerRow
	err := tx.QueryRow(ctx, `SELECT `+computerColumns+` FROM computers WHERE id = $1`, computerID).Scan(
		&row.ID, &row.Kind, &row.State, &row.Scope, &row.ControlHolder, &row.ControlBotID, &row.HomeRevision,
		&row.MaintenanceID, &row.DiskUsedBytes, &row.DiskFreeBytes, &row.DiskDismissedPercent,
		&row.ControlUserID, &row.ControlLeaseID, &row.UserID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	return &row, err
}

// computerWork is resolveComputerWork: which run holds the bot's computer, and whether a run waits
// for the person to take over.
type computerWork struct {
	BusyBotName     *string
	TakeoverRequest bool
}

func resolveComputerWork(ctx context.Context, tx pgx.Tx, computerID, botID, botName string) (computerWork, error) {
	if computerID == "" {
		return computerWork{}, nil
	}
	var expiresAt time.Time
	var leaseRunID string
	leased := true
	err := tx.QueryRow(ctx, `SELECT "expiresAt", "runId" FROM computer_execution_leases
		WHERE "computerId" = $1 AND "botId" = $2`, computerID, botID).Scan(&expiresAt, &leaseRunID)
	if errors.Is(err, pgx.ErrNoRows) {
		leased = false
	} else if err != nil {
		return computerWork{}, err
	}
	var waiting bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM runs WHERE "botId" = $1 AND status = 'waiting_takeover')`, botID).Scan(&waiting); err != nil {
		return computerWork{}, err
	}
	var runStatus *string
	if leased {
		var status string
		err := tx.QueryRow(ctx, `SELECT status FROM runs WHERE id = $1`, leaseRunID).Scan(&status)
		if err == nil {
			runStatus = &status
		} else if !errors.Is(err, pgx.ErrNoRows) {
			return computerWork{}, err
		}
	}
	leaseActive := leased && expiresAt.After(time.Now())
	runActive := runStatus != nil && activeRunStatuses[*runStatus]
	heldWithoutRun := leaseActive && runStatus == nil
	working := (runStatus == nil || *runStatus != "waiting_takeover") && (runActive || heldWithoutRun)
	work := computerWork{TakeoverRequest: waiting}
	if working {
		work.BusyBotName = &botName
	}
	return work, nil
}

// diskUsedPercent is diskUsedPercent: the percent full as df reports it, rounded up.
func diskUsedPercent(used, free *int64) (int64, bool) {
	if used == nil || free == nil {
		return 0, false
	}
	total := new(big.Int).Add(big.NewInt(*used), big.NewInt(*free))
	if total.Sign() == 0 {
		return 0, false
	}
	numerator := new(big.Int).Mul(big.NewInt(*used), big.NewInt(100))
	numerator.Add(numerator, total)
	numerator.Sub(numerator, big.NewInt(1))
	return new(big.Int).Quo(numerator, total).Int64(), true
}

// computerStatus is toComputerStatus. ok is false when the row breaks ComputerStatusSchema.
func computerStatus(botID string, computer *computerRow, work computerWork, shared bool, viewerID string) (map[string]any, bool) {
	holds := func(row *computerRow) bool {
		holder := ""
		if row.ControlUserID != nil && *row.ControlUserID != "" {
			holder = *row.ControlUserID
		} else if row.UserID != nil {
			holder = *row.UserID
		}
		return holder == "" || holder == viewerID
	}
	status := map[string]any{"botId": botID}
	if shared {
		status["shared"] = true
	}
	if computer != nil && computer.ControlHolder == "user" && !holds(computer) {
		status["controlledByOther"] = true
	}
	if computer != nil && computer.ControlHolder == "user" && computer.ControlBotID != nil && *computer.ControlBotID == botID &&
		computer.ControlLeaseID != nil && *computer.ControlLeaseID != "" && holds(computer) {
		status["controlLeaseId"] = *computer.ControlLeaseID
	}
	kind := "fake"
	if computer != nil {
		kind = computer.Kind
	}
	state := "stopped"
	switch {
	case kind == "none":
	case computer != nil && computer.MaintenanceID != nil && *computer.MaintenanceID != "":
		state = "booting"
	case computer != nil && computer.State == "quarantined":
		state = "error"
	case computer != nil && computer.State == "suspending":
		state = "running"
	case computer != nil && (computer.State == "stopped" || computer.State == "booting" || computer.State == "running" ||
		computer.State == "suspended" || computer.State == "error"):
		state = computer.State
	}
	capabilities := sandboxKindCapabilities(kind)
	var diskPercent int64
	hasPercent := false
	dismissed := int32(0)
	if computer != nil {
		diskPercent, hasPercent = diskUsedPercent(computer.DiskUsedBytes, computer.DiskFreeBytes)
		if computer.DiskDismissedPercent != nil {
			dismissed = *computer.DiskDismissedPercent
		}
	}
	mode := "team"
	holder := "none"
	var controlBotID any
	var homeRevision any
	if computer != nil {
		if computer.Scope == "dedicated" {
			mode = "dedicated"
		}
		holder = computer.ControlHolder
		if computer.ControlBotID != nil {
			controlBotID = *computer.ControlBotID
		}
		homeRevision = computer.HomeRevision
	}
	maintenance := computer != nil && computer.MaintenanceID != nil && *computer.MaintenanceID != ""
	status["mode"] = mode
	status["kind"] = kind
	status["state"] = state
	status["controlHolder"] = holder
	status["controlBotId"] = controlBotID
	status["takeoverRequested"] = work.TakeoverRequest
	status["screenAvailable"] = !maintenance && (state == "running" || state == "booting")
	status["screenWidth"] = capabilities.Width
	status["screenHeight"] = capabilities.Height
	status["homeRevision"] = homeRevision
	if work.BusyBotName != nil {
		status["busyBotName"] = *work.BusyBotName
	} else {
		status["busyBotName"] = nil
	}
	status["canUpdate"] = capabilities.InPlaceUpdate
	status["terminalAvailable"] = capabilities.Terminal
	if capabilities.RunsOnUserMachine {
		status["runsOnUserMachine"] = true
	}
	if hasPercent && diskPercent >= diskWarningPercent && diskPercent > int64(dismissed) {
		status["diskFullPercent"] = diskPercent
	}
	// ComputerStatusSchema: a kind is non-empty, the holder one of three, ids non-empty, the
	// disk percent within 0..100 (a used size above total/free makes it larger).
	if kind == "" || (holder != "bot" && holder != "user" && holder != "none") {
		return nil, false
	}
	if id, ok := controlBotID.(string); ok && id == "" {
		return nil, false
	}
	if id, ok := status["controlLeaseId"].(string); ok && id == "" {
		return nil, false
	}
	if percent, ok := status["diskFullPercent"].(int64); ok && percent > 100 {
		return nil, false
	}
	if capabilities.Width <= 0 || capabilities.Height <= 0 {
		return nil, false
	}
	return status, true
}
