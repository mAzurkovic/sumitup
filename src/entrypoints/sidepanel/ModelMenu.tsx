import { MODELS } from '@/lib/models';

export const MODEL_MENU_ID = 'model-menu';

export const KEY_NOTICE = 'Page content is sent to the provider you select. Your key stays on this device.';

interface ModelMenuProps {
  modelId: string;
  keyEnding: string;
  onModelChange: (modelId: string) => void;
  onDeleteKey: () => void;
}

export function ModelMenu({ modelId, keyEnding, onModelChange, onDeleteKey }: ModelMenuProps) {
  const current = MODELS.find(({ id }) => id === modelId);
  return (
    <div className="control grow">
      <span className="label" id="model-label">
        Model
      </span>
      <button type="button" className="pill" popoverTarget={MODEL_MENU_ID} aria-labelledby="model-label">
        {current?.name}
      </button>
      <div id={MODEL_MENU_ID} popover="auto" className="menu">
        <div role="group" aria-label="Models" className="models">
          {MODELS.map(({ id, name, isDefault }) => (
            <button
              key={id}
              type="button"
              className="model"
              role="menuitemradio"
              aria-checked={id === modelId}
              popoverTarget={MODEL_MENU_ID}
              popoverTargetAction="hide"
              onClick={() => onModelChange(id)}
            >
              {name}
              {isDefault && <span className="note">default</span>}
            </button>
          ))}
        </div>
        <hr className="divider" />
        <span className="label">API key</span>
        <div className="row">
          <span className="field" aria-label="Saved API key">
            {'••••••••' + keyEnding}
          </span>
          <button type="button" className="link" onClick={onDeleteKey}>
            Delete
          </button>
        </div>
        <p className="note">{KEY_NOTICE}</p>
      </div>
    </div>
  );
}
