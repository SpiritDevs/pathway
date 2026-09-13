import { AssetLibrary } from "../assets/AssetLibrary";
import { useCompanySettings } from "./company/useCompanySettings";
import { SettingsPageContainer } from "./settingsLayout";
export function AssetsSettingsPanel() {
  const { contentCompanyId } = useCompanySettings();
  return (
    <SettingsPageContainer className="max-w-4xl">
      {contentCompanyId ? (
        <AssetLibrary companyId={contentCompanyId} />
      ) : (
        <p className="text-sm text-muted-foreground">Choose a company to manage its assets.</p>
      )}
    </SettingsPageContainer>
  );
}
