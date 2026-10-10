package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/maximhq/bifrost/core/schemas"
	"github.com/maximhq/bifrost/framework/configstore"
	"github.com/maximhq/bifrost/framework/configstore/tables"
	"github.com/maximhq/bifrost/framework/guardrails"
	dynamicPlugins "github.com/maximhq/bifrost/framework/plugins"
	"github.com/maximhq/bifrost/transports/bifrost-http/handlers"
)

// ApplyPluginConfig 串行校验候选实例，持久化成功后才发布，失败保留当前实例。
func (s *BifrostHTTPServer) ApplyPluginConfig(ctx context.Context, row *tables.TablePlugin, create bool) error {
	s.pluginChangeMu.Lock()
	defer s.pluginChangeMu.Unlock()
	if s.Config.ConfigStore == nil || s.Client == nil {
		return fmt.Errorf("plugin management is unavailable")
	}
	if row.Name == "guardrails" {
		cfg, err := guardrails.DecodeConfig(row.Config)
		if err != nil {
			return &handlers.InvalidPluginConfigurationError{Err: err}
		}
		cfg.Enabled = row.Enabled
		row.Config = cfg
	}
	candidate, err := InstantiatePlugin(ctx, row.Name, row.Path, row.Config, s.Config)
	if err != nil {
		return &handlers.InvalidPluginConfigurationError{Err: err}
	}
	if candidate == nil {
		return fmt.Errorf("plugin initialization returned no instance")
	}
	published := false
	defer func() {
		if !published {
			if guardrail, ok := candidate.(*hostGuardrailPlugin); ok {
				_ = guardrail.Plugin.Cleanup()
			} else {
				_ = candidate.Cleanup()
			}
		}
	}()
	if marshaller, ok := candidate.(schemas.ConfigMarshallerPlugin); ok {
		config, ok := row.Config.(map[string]any)
		if !ok {
			raw, encodeErr := schemas.MarshalSorted(row.Config)
			if encodeErr != nil {
				return &handlers.InvalidPluginConfigurationError{Err: encodeErr}
			}
			if decodeErr := json.Unmarshal(raw, &config); decodeErr != nil {
				return &handlers.InvalidPluginConfigurationError{Err: decodeErr}
			}
		}
		row.Config, err = marshaller.MarshalConfigForStorage(config)
		if err != nil {
			return &handlers.InvalidPluginConfigurationError{Err: err}
		}
	}
	old, err := s.Config.ConfigStore.GetPlugin(ctx, row.Name)
	if err != nil && !errors.Is(err, configstore.ErrNotFound) {
		return err
	}
	if old != nil {
		row.ConfigHash, row.Version = old.ConfigHash, old.Version
	}
	if create {
		err = s.Config.ConfigStore.CreatePlugin(ctx, row)
	} else {
		err = s.Config.ConfigStore.UpdatePlugin(ctx, row)
	}
	if err != nil {
		return err
	}
	if row.Enabled {
		err = s.reloadPluginInstance(ctx, row.Name, candidate, row.Placement, row.Order)
		if err == nil {
			published = true
		}
	} else {
		err = s.RemovePlugin(context.WithValue(ctx, handlers.PluginDisabledKey, true), row.Name)
		if errors.Is(err, dynamicPlugins.ErrPluginNotFound) {
			s.markPluginDisabled(row.Name)
			err = nil
		}
		if err == nil {
			if guardrail, ok := candidate.(*hostGuardrailPlugin); ok {
				s.publishGuardrailManagement(guardrail.Plugin)
				published = true
			}
		}
	}
	if err != nil {
		if old != nil {
			if restoreErr := s.Config.ConfigStore.UpsertPlugin(ctx, old); restoreErr != nil {
				return fmt.Errorf("plugin publish failed: %v; restoring stored configuration failed: %w", err, restoreErr)
			}
		} else if restoreErr := s.Config.ConfigStore.DeletePlugin(ctx, row.Name); restoreErr != nil {
			return fmt.Errorf("plugin publish failed: %v; removing rejected configuration failed: %w", err, restoreErr)
		}
		return err
	}
	s.Config.RememberPluginConfig(row)
	return nil
}

// DeletePluginConfiguration 先提交配置删除，再解除运行时注册，不清理历史业务数据。
func (s *BifrostHTTPServer) DeletePluginConfiguration(ctx context.Context, name string) error {
	s.pluginChangeMu.Lock()
	defer s.pluginChangeMu.Unlock()
	if s.Config.ConfigStore == nil {
		return fmt.Errorf("plugin management is unavailable")
	}
	if err := s.Config.ConfigStore.DeletePlugin(ctx, name); err != nil {
		return err
	}
	if err := s.RemovePlugin(ctx, name); err != nil && !errors.Is(err, dynamicPlugins.ErrPluginNotFound) {
		return err
	}
	s.Config.DeletePluginOverallStatus(name)
	s.Config.RemoveConfigMarshaller(name)
	s.Config.ForgetPluginConfig(name)
	return nil
}
