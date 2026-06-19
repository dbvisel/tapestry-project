/**
 * Block editor script for the "Tapestry" block (tapestries/viewer).
 *
 * Written against the global `wp.*` packages (no build step). It lets an author pick an exported Tapestry
 * ZIP from the Media Library, choose a height, and shows a live preview of the bundled viewer. The block is
 * dynamic: `save` returns null and the front-end markup is produced by the PHP render_callback.
 */
( function ( wp ) {
	const { registerBlockType } = wp.blocks;
	const { createElement: el, Fragment } = wp.element;
	const { useBlockProps, MediaUpload, MediaUploadCheck, InspectorControls, BlockControls } =
		wp.blockEditor;
	const { Button, Placeholder, PanelBody, RangeControl, ToolbarGroup, ToolbarButton } = wp.components;
	const { __ } = wp.i18n;

	const config = window.TapestriesBlock || {};

	function viewerSrc( zipUrl ) {
		return config.viewerUrl + '?source=' + encodeURIComponent( zipUrl );
	}

	registerBlockType( 'tapestries/viewer', {
		edit: function ( props ) {
			const attributes = props.attributes;
			const setAttributes = props.setAttributes;
			const blockProps = useBlockProps();
			const height = attributes.height || 600;

			function onSelect( media ) {
				setAttributes( {
					zipUrl: media.url,
					zipId: media.id,
					title: media.title || media.filename || '',
				} );
			}

			const inspector = el(
				InspectorControls,
				{},
				el(
					PanelBody,
					{ title: __( 'Viewer settings', 'tapestries' ), initialOpen: true },
					el( RangeControl, {
						label: __( 'Height (px)', 'tapestries' ),
						value: height,
						min: 200,
						max: 1600,
						step: 20,
						onChange: function ( value ) {
							setAttributes( { height: value || 600 } );
						},
					} )
				)
			);

			// Not configured yet: show an upload placeholder.
			if ( ! attributes.zipUrl ) {
				return el(
					'div',
					blockProps,
					inspector,
					el(
						MediaUploadCheck,
						{},
						el( MediaUpload, {
							onSelect: onSelect,
							value: attributes.zipId,
							// Intentionally no allowedTypes filter: depending on server config a .zip may be
							// stored as application/zip or application/octet-stream, and filtering can hide it.
							render: function ( open ) {
								return el(
									Placeholder,
									{
										icon: 'images-alt2',
										label: __( 'Tapestry', 'tapestries' ),
										instructions: __(
											'Upload or select an exported Tapestry ZIP file.',
											'tapestries'
										),
									},
									el(
										Button,
										{ variant: 'primary', onClick: open.open },
										__( 'Select Tapestry ZIP', 'tapestries' )
									)
								);
							},
						} )
					)
				);
			}

			// Configured: show a live preview plus a toolbar "Replace" action.
			const toolbar = el(
				BlockControls,
				{},
				el(
					ToolbarGroup,
					{},
					el(
						MediaUploadCheck,
						{},
						el( MediaUpload, {
							onSelect: onSelect,
							value: attributes.zipId,
							render: function ( open ) {
								return el(
									ToolbarButton,
									{ onClick: open.open },
									__( 'Replace ZIP', 'tapestries' )
								);
							},
						} )
					)
				)
			);

			const preview = config.viewerUrl
				? el( 'iframe', {
						src: viewerSrc( attributes.zipUrl ),
						style: { width: '100%', height: height + 'px', border: 0, display: 'block' },
						title: attributes.title || 'Tapestry',
				  } )
				: el(
						Placeholder,
						{ icon: 'images-alt2', label: __( 'Tapestry', 'tapestries' ) },
						__( 'Viewer URL unavailable.', 'tapestries' )
				  );

			return el(
				'div',
				blockProps,
				inspector,
				toolbar,
				el( 'div', { style: { position: 'relative' } }, preview )
			);
		},

		// Dynamic block: front-end HTML comes from the PHP render_callback.
		save: function () {
			return null;
		},
	} );
} )( window.wp );
