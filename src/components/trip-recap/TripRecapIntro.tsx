import {AppShell, Badge, Button, Card, Heading, Stack, Text} from "@astryxdesign/core";

export default function TripRecapIntro() {
  return (
    <AppShell height="auto" contentPadding={0} variant="section" className="trip-app">
      <div className="trip-page landing-page">
        <div className="trip-header">
          <div className="trip-header-mark" aria-hidden="true">TR</div>
          <div className="trip-header-copy">
            <Text as="p" type="label" className="eyebrow">TRIP RECAP / MEDIA → MEMORY</Text>
            <Heading level={1} type="display-1">Make a trip out of the camera roll.</Heading>
            <Text as="p" type="supporting" className="trip-lede">
              Retain the original media. Let its metadata draw the route. The map remembers what the camera actually saw.
            </Text>
          </div>
          <Badge variant="purple" label="METADATA FIRST" />
        </div>

        <section className="hero-grid" aria-label="Trip recap introduction">
          <Stack gap={4} className="hero-copy">
            <Text as="p" type="label" className="eyebrow">THE SHORT VERSION</Text>
            <Heading level={2}>Upload once. Inspect the evidence. Press play.</Heading>
            <Text as="p" type="body" color="secondary">
              GPS observations stay distinct from the roads inferred between them. Missing metadata stays missing — never quietly invented.
            </Text>
            <div className="hero-note">
              <span className="hero-note-number">01</span>
              <Text as="p" type="supporting">Your files upload in parallel and can be discarded before analysis.</Text>
            </div>
            <Button href="/recap" label="Start a recap" variant="primary" size="lg" />
          </Stack>
          <Card variant="purple" padding={5} className="workflow-card">
            <Stack gap={3}>
              <Text as="p" type="label" className="eyebrow">WORKFLOW / 01—04</Text>
              <div className="workflow-line"><span>01</span><Text type="body">retain media</Text></div>
              <div className="workflow-line"><span>02</span><Text type="body">extract metadata</Text></div>
              <div className="workflow-line"><span>03</span><Text type="body">trace the road</Text></div>
              <div className="workflow-line"><span>04</span><Text type="body">replay the day</Text></div>
            </Stack>
          </Card>
        </section>

        <div className="trip-footer">
          <Text as="p" type="label" className="eyebrow">TRIP RECAP / {new Date().getFullYear()}</Text>
          <Text as="p" type="supporting">Temporary processing. No gallery, no invented coordinates.</Text>
        </div>
      </div>
    </AppShell>
  );
}
