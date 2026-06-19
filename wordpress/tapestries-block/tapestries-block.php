<?php
/**
 * Plugin Name:       Tapestries Block
 * Description:       Embed an exported Tapestry ZIP file as an interactive, zoomable viewer inside a post or page.
 * Version:           0.1.0
 * Requires at least: 6.3
 * Requires PHP:      7.4
 * Author:            Internet Archive
 * License:           MIT
 * Text Domain:       tapestries
 *
 * The block is rendered dynamically (see tapestries_block_render): the saved post only stores the chosen
 * ZIP attachment URL, and on the front end we emit an <iframe> pointing at the bundled viewer app with a
 * `?source=<zip url>` parameter. The viewer (a self-contained static SPA shipped under ./viewer) fetches
 * the ZIP, unpacks it in the browser, and renders the tapestry. No server-side processing of the ZIP.
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit; // Don't allow direct access.
}

/**
 * Render callback for the tapestries/viewer block.
 *
 * @param array $attributes Block attributes (zipUrl, height, title).
 * @return string Front-end HTML.
 */
function tapestries_block_render( $attributes ) {
	$zip_url = isset( $attributes['zipUrl'] ) ? trim( (string) $attributes['zipUrl'] ) : '';
	if ( '' === $zip_url ) {
		// Nothing chosen yet (e.g. block inserted but never configured) - render nothing on the front end.
		return '';
	}

	$height = isset( $attributes['height'] ) ? (int) $attributes['height'] : 600;
	$height = max( 200, min( 2000, $height ) );
	$title  = isset( $attributes['title'] ) ? (string) $attributes['title'] : 'Tapestry';

	// The bundled viewer is built with a relative asset base, so it works from this plugin sub-directory.
	$viewer_url = plugins_url( 'viewer/index.html', __FILE__ );
	$src        = $viewer_url . '?source=' . rawurlencode( $zip_url );

	$wrapper = get_block_wrapper_attributes( array( 'class' => 'tapestry-viewer-block' ) );

	return sprintf(
		'<div %1$s><iframe class="tapestry-viewer-frame" src="%2$s" style="width:100%%;height:%3$dpx;border:0;" loading="lazy" allowfullscreen title="%4$s"></iframe></div>',
		$wrapper,
		esc_url( $src ),
		$height,
		esc_attr( $title )
	);
}

/**
 * Register the editor script, hand the viewer URL to it, and register the block.
 */
function tapestries_block_init() {
	$editor_asset = plugin_dir_path( __FILE__ ) . 'editor.js';

	wp_register_script(
		'tapestries-block-editor',
		plugins_url( 'editor.js', __FILE__ ),
		array( 'wp-blocks', 'wp-element', 'wp-block-editor', 'wp-components', 'wp-i18n' ),
		file_exists( $editor_asset ) ? (string) filemtime( $editor_asset ) : '0.1.0',
		true
	);

	// Expose the viewer URL so the editor can show a live preview iframe.
	wp_localize_script(
		'tapestries-block-editor',
		'TapestriesBlock',
		array( 'viewerUrl' => plugins_url( 'viewer/index.html', __FILE__ ) )
	);

	register_block_type(
		__DIR__ . '/block.json',
		array(
			'editor_script'   => 'tapestries-block-editor',
			'render_callback' => 'tapestries_block_render',
		)
	);
}
add_action( 'init', 'tapestries_block_init' );

/**
 * WordPress does not allow .zip uploads to the Media Library by default. Enable it so authors can upload
 * exported tapestries. (Note: WordPress still applies a real-MIME check; administrators are exempt, but on
 * some multisite configs non-admins may need the `unfiltered_upload` capability.)
 */
function tapestries_block_allow_zip_uploads( $mimes ) {
	$mimes['zip'] = 'application/zip';
	return $mimes;
}
add_filter( 'upload_mimes', 'tapestries_block_allow_zip_uploads' );
