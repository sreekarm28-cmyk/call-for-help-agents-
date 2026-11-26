import assert from 'node:assert/strict';

function installGoogleMocks() {
  const originalFetch = globalThis.fetch;
  const locations = new Map([
    ['Strict test address', 12.97], ['Fallback test address', 13],
    ['Empty test address', 14], ['Places failure test address', 15],
    ['Custom trade test address', 16], ['Unrated test address', 17],
    ['Legacy test address', 12.97],
  ]);
  let vendorSearchCount = 0;
  let extractionCalls = 0;
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.hostname === 'generativelanguage.googleapis.com') {
      const body = JSON.parse(String(init?.body));
      const inputText: string = body.contents[0].parts[0].text;
      if (body.systemInstruction.parts[0].text.startsWith('Decide the outcome of a booking CONFIRMATION')) {
        const [termsText, transcript] = inputText.replace(/^Agreed booking terms:\n/, '').split('\n\nTranscript:\n');
        const terms = JSON.parse(termsText);
        assert.ok(body.systemInstruction.parts[0].text.includes('latest provider answer'));
        const declined = transcript.includes('You: I cannot attend.') || transcript.includes('You: No, do not book it.');
        const uncertain = transcript.includes('You: Maybe, call me later.') || transcript.includes('You: Yes, this is my number.');
        const evidence = transcript.includes('You: No, do not book it.') ? 'No, do not book it.'
          : declined ? 'I cannot attend.' : uncertain ? (transcript.includes('You: Maybe, call me later.')
            ? 'Maybe, call me later.' : 'Yes, this is my number.') : 'I accept those terms.';
        const question = transcript.split('\n').filter((line: string) => line.startsWith('Agent:')).at(-1)?.slice(7) ?? null;
        return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify({
          decision: declined ? 'declined' : uncertain ? 'needs_clarification' : 'confirmed',
          final_answer: declined ? 'no' : uncertain ? 'unclear' : 'yes',
          confirmation_question: transcript.includes('missing final question') ? null : question,
          confirmation_answer: evidence,
          visit_date: declined || uncertain ? null : terms.visitDate,
          visit_time: declined || uncertain ? null : transcript.includes('changed time') ? '23:59' : terms.visitTime,
          visit_fee: declined || uncertain ? null : transcript.includes('changed fee') ? 999 : Number(terms.visitFee),
          summary: declined ? 'Provider declined.' : uncertain ? 'Provider is unsure.' : 'Provider accepted.',
          evidence: [evidence],
        }) }] } }] });
      }
      const referenceDate = /^Reference call date: (\d{4}-\d{2}-\d{2}) \(Asia\/Kolkata\)\n\nAgent:/.exec(inputText);
      assert.ok(referenceDate, 'Extraction receives a reference call date.');
      assert.match(inputText, /You: The visit is ₹350/);
      assert.ok(body.systemInstruction.parts[0].text.includes('repair'));
      if (++extractionCalls === 1) return new Response(null, { status: 503 });
      const tomorrow = new Date(referenceDate[1] + 'T00:00:00Z');
      tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
      return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify({
        provider_response: 'offer_received', visit_fee: 350, fee_covers: 'Inspection',
        repair_fee_min: 700, repair_fee_max: 900, repair_cost_notes: 'Parts extra.',
        visit_date: tomorrow.toISOString().slice(0, 10), visit_time: '13:00',
        availability_as_said: 'Tomorrow at 1 p.m.', summary: 'Visit tomorrow at 1 p.m. for ₹350.',
        evidence: ['The visit is ₹350', 'Made up evidence'],
      }) }] } }] });
    }
    if (url.hostname === 'maps.googleapis.com') {
      throw new Error('The flow test must use mocked Places address lookup.');
    }
    if (url.hostname !== 'places.googleapis.com') return originalFetch(input, init);

    const headers = new Headers(init?.headers);
    assert.equal(headers.get('x-goog-api-key'), 'test-key');
    if (url.pathname.startsWith('/v1/places/test-place-')) {
      const fieldMask = headers.get('x-goog-fieldmask');
      assert.ok(fieldMask === 'displayName,addressComponents'
        || fieldMask === 'displayName,addressComponents,rating,userRatingCount'
        || fieldMask === 'displayName,addressComponents,rating,userRatingCount,internationalPhoneNumber,nationalPhoneNumber');
      const number = url.pathname.split('-').at(-1);
      return Response.json({
        displayName: { text: `Test Plumber ${number}` },
        rating: 4.5,
        userRatingCount: 20,
        internationalPhoneNumber: '+919999900000',
        addressComponents: [
          { longText: 'Bengaluru', types: ['locality'] },
          { longText: 'Indiranagar', types: ['sublocality_level_1'] },
        ],
      });
    }
    const body = JSON.parse(String(init?.body));
    if (url.pathname === '/v1/places:searchText' && body.pageSize === 2) {
      if (process.argv.some((arg) => arg.endsWith('worker.ts'))) {
        assert.equal(body.textQuery, 'Legacy test address', 'The worker must reuse verified coordinates for new requests.');
      }
      assert.match(headers.get('x-goog-fieldmask') ?? '', /places\.location/);
      if (body.textQuery === 'Ambiguous test address') {
        return Response.json({ places: [
          { types: ['street_address'], location: { latitude: 12, longitude: 77.6 } },
          { types: ['street_address'], location: { latitude: 13, longitude: 77.6 } },
        ] });
      }
      if (['Test street, Bengaluru 560038, India', 'Test street, Bengaluru 560039, India'].includes(body.textQuery)) {
        return Response.json({ places: [{
          formattedAddress: 'Test street, Bengaluru 560038',
          types: ['route'],
          location: { latitude: 12.97, longitude: 77.6 },
          addressComponents: [{ longText: 'Karnataka', types: ['administrative_area_level_1'] }],
        }] });
      }
      const latitude = locations.get(body.textQuery);
      return Response.json(latitude === undefined ? {} : { places: [{
        formattedAddress: body.textQuery,
        types: ['street_address'],
        location: { latitude, longitude: 77.6 },
        addressComponents: [{ longText: 'Andhra Pradesh', types: ['administrative_area_level_1'] }],
      }] });
    }
    assert.equal(++vendorSearchCount, 1, 'A search must make only one vendor lookup.');
    const circle = body.locationRestriction?.circle ?? body.locationBias?.circle;
    const latitude = circle.center.latitude;
    assert.equal(circle.center.longitude, 77.6);
    assert.equal(circle.radius, 10_000);
    assert.match(headers.get('x-goog-fieldmask') ?? '', /places\.primaryType/);
    assert.match(headers.get('x-goog-fieldmask') ?? '', /places\.businessStatus/);
    assert.match(headers.get('x-goog-fieldmask') ?? '', /places\.addressComponents/);
    assert.ok(!headers.get('x-goog-fieldmask')?.includes('editorialSummary'));

    function vendor(number: number, rating: number) {
      return {
        id: `test-place-${number}`,
        displayName: { text: `Test Plumber ${number}` },
        internationalPhoneNumber: `+9198765000${String(number).padStart(2, '0')}`,
        primaryType: 'plumber',
        businessStatus: 'OPERATIONAL',
        rating,
        userRatingCount: 20,
        location: { latitude, longitude: 77.6 },
      };
    }

    if (latitude === 16) {
      assert.equal(url.pathname, '/v1/places:searchText');
      assert.equal(body.textQuery, 'AC repair');
      assert.equal(body.pageSize, 20);
      return Response.json({ places: [{
        ...vendor(1, 4.4), primaryType: 'general_contractor',
        displayName: { text: 'Bengaluru AC Repair Service' },
      }] });
    }
    assert.equal(url.pathname, '/v1/places:searchNearby');
    assert.deepEqual(body.includedTypes, ['plumber']);
    assert.equal(body.maxResultCount, 20);
    if (latitude === 15) return Response.json({}, { status: 503 });
    if (latitude === 14) return Response.json({});
    if (latitude === 13) return Response.json({ places: [
      vendor(1, 4.4),
      vendor(2, 3.6),
      { ...vendor(3, 3.5), primaryType: 'general_contractor', types: ['plumber'] },
      vendor(4, 3.1),
      { ...vendor(5, 3), rating: undefined },
      { ...vendor(1, 3.8), id: 'duplicate-fallback-phone' },
      { ...vendor(6, 3.9), id: 'test-place-1' },
      { ...vendor(7, 4.9), primaryType: 'hardware_store' },
    ] });
    if (latitude === 17) return Response.json({ places: [{ ...vendor(1, 3), rating: undefined }] });
    assert.equal(latitude, 12.97);
    return Response.json({ places: [
      ...Array.from({ length: 7 }, (_, index) => vendor(index + 1, 4.5)),
      { ...vendor(1, 4.0), id: 'duplicate-phone' },
      { ...vendor(8, 4.9), businessStatus: 'CLOSED_PERMANENTLY' },
      { ...vendor(9, 4.9), primaryType: 'hardware_store' },
      { ...vendor(10, 4.9), internationalPhoneNumber: undefined },
      { ...vendor(11, 4.9), location: { latitude: latitude + 0.2, longitude: 77.6 } },
    ] });
  };
}


installGoogleMocks();
