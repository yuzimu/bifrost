package resilience

import (
	"encoding/json"
	"errors"
	"fmt"
	"time"

	providerUtils "github.com/maximhq/bifrost/core/providers/utils"
	"github.com/maximhq/bifrost/core/schemas"
	"github.com/maximhq/bifrost/framework/kvstore"
)

type Option func(*Runtime) error

type HeldMetadata struct {
	HoldSnapshot
	Rung     int       `json:"rung"`
	Released time.Time `json:"released_at,omitempty"`
}

type RuntimeMetadata struct {
	UpdatedAt time.Time      `json:"updated_at"`
	Holds     []HeldMetadata `json:"holds"`
}

// WithKVStore 使用已有 KV 保存指定单进程命名空间的 held metadata，不提供分布式 CAS。
func WithKVStore(store schemas.KVStore, namespace string) Option {
	return func(r *Runtime) error {
		if store == nil || namespace == "" {
			return fmt.Errorf("KV store and a process-owned metadata namespace are required")
		}
		r.kv, r.metadataKey = store, "resilience:metadata:"+namespace
		raw, err := store.Get(r.metadataKey)
		if errors.Is(err, kvstore.ErrNotFound) {
			return nil
		}
		if err != nil {
			return fmt.Errorf("restore resilience metadata: %w", err)
		}
		encoded, err := providerUtils.MarshalSorted(raw)
		if err != nil {
			return err
		}
		var metadata RuntimeMetadata
		if err := json.Unmarshal(encoded, &metadata); err != nil {
			return fmt.Errorf("invalid resilience metadata: %w", err)
		}
		now := time.Now()
		for _, entry := range metadata.Holds {
			if entry.KeyID == "" || entry.Provider == "" || holdCap(entry.Reason) == 0 ||
				now.Sub(metadata.UpdatedAt) > stateTTL || entry.Rung < 0 || entry.Rung > 10000 {
				continue
			}
			t := target{entry.Provider, entry.Model, entry.KeyID}
			r.holds[t] = &hold{class: entry.Reason, since: entry.Since, until: entry.Due,
				updated: metadata.UpdatedAt, released: entry.Released, rung: entry.Rung}
		}
		return nil
	}
}

// persistMetadata 仅保存无凭据的 hold/阶梯；现有 KV 是否持久化由具体 store 决定。
func (r *Runtime) persistMetadata(now time.Time) {
	if r.kv == nil {
		return
	}
	r.mu.Lock()
	metadata := RuntimeMetadata{UpdatedAt: now, Holds: []HeldMetadata{}}
	for t, h := range r.holds {
		metadata.Holds = append(metadata.Holds, HeldMetadata{
			HoldSnapshot: HoldSnapshot{Provider: t.provider, Model: t.model, KeyID: t.key,
				Reason: h.class, Since: h.since, Due: h.until},
			Rung: h.rung, Released: h.released,
		})
	}
	r.mu.Unlock()
	if err := r.kv.SetWithTTL(r.metadataKey, metadata, stateTTL); err != nil && r.logger != nil {
		r.logger.Warn("failed to save resilience runtime metadata: %v", err)
	}
}
