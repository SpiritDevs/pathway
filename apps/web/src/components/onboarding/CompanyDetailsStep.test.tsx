import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { CompanyDetailsStep } from "./CompanyDetailsStep";

const noop = vi.fn();

describe("CompanyDetailsStep", () => {
  it("uses the onboarding card as a required additional-company flow", () => {
    const markup = renderToStaticMarkup(
      <CompanyDetailsStep
        error={null}
        name=""
        onBack={noop}
        onFinish={noop}
        onNameChange={noop}
        onReferralDetailChange={noop}
        onReferralSourceToggle={noop}
        onRoleToggle={noop}
        onSizeToggle={noop}
        pending={false}
        referralDetail=""
        referralSource={null}
        role={null}
        size={null}
        variant="create"
      />,
    );

    expect(markup).toContain("Create a company");
    expect(markup).toContain("How many people will use Pathway?");
    expect(markup).toContain("How did you hear about us?");
    expect(markup).not.toContain("Skip for now");
    expect(markup).toContain("disabled");
  });
});
